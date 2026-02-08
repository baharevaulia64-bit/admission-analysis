import express from 'express';
import multer from 'multer';
import mysql from 'mysql2/promise';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import PDFTable from 'pdfkit-table';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = 3000;

// Настройка базы данных с поддержкой кириллицы
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '55758690',
  database: 'admission_db',
  charset: 'utf8mb4', // Важно для поддержки кириллицы
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z' // Фикс проблемы с часовыми поясами при работе с датами
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Middleware для правильной кодировки
app.use((req, res, next) => {
  res.header('Content-Type', 'application/json; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Функция для конвертации даты из 'DD.MM.YYYY' в 'YYYY-MM-DD'
function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr; // Если уже в правильном формате
}

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// Загрузка файлов с поддержкой кириллицы — полная замена данных по программе
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('=== НАЧАЛО ЗАГРУЗКИ ===');

  let { program, date } = req.body;
  const filePath = req.file?.path;

  // Конвертируем дату в формат БД (YYYY-MM-DD)
  date = convertDateFormat(date);

  console.log('Программа:', program);
  console.log('Конвертированная дата:', date);
  console.log('Путь к файлу:', filePath);

  if (!program || !date || !filePath) {
    console.error('Не хватает обязательных полей:', { program, date, filePath });
    return res.status(400).json({
      success: false,
      message: 'Не указана образовательная программа, дата или файл'
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // ─────────────────────────────────────────────────────────────
    // ★ ВАРИАНТ А: ПОЛНАЯ ЗАМЕНА ВСЕХ ДАННЫХ ПО ЭТОЙ ПРОГРАММЕ
    // ─────────────────────────────────────────────────────────────
    console.log(`[ЗАМЕНА ДАННЫХ] Полная очистка всех предыдущих записей по программе "${program}" ...`);

    // 1. Удаляем ВСЕ приоритеты по этой программе (независимо от даты)
    const [delPrior] = await connection.query(`
      DELETE FROM priorities
      WHERE program_code = ?
    `, [program]);
    console.log(`   → удалено из priorities: ${delPrior.affectedRows} строк`);

    // 2. Удаляем ВСЕ результаты симуляций зачисления по этой программе
    const [delEnroll] = await connection.query(`
      DELETE FROM enrollment
      WHERE program_code = ?
    `, [program]);
    console.log(`   → удалено из enrollment: ${delEnroll.affectedRows} строк`);


    console.log(`Очистка завершена. Теперь вставляем только новые данные из файла.`);

    // Начинаем транзакцию для вставки новых данных
    await connection.beginTransaction();

    // ─────── Чтение Excel ───────
    const workbook = XLSX.readFile(filePath, {
      codepage: 65001,
      cellDates: true,
      cellNF: false,
      cellStyles: false,
      sheetStubs: false
    });

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      raw: false,
      defval: '',
      blankrows: false
    });

    console.log(`Прочитано строк из Excel: ${jsonData.length}`);

    if (jsonData.length === 0) {
      throw new Error('Файл пустой или имеет неправильный формат');
    }

    let inserted = 0;
    let updated = 0;
    let errors = 0;
    let skipped = 0;

    for (const row of jsonData) {
      try {
        // 1. ID абитуриента
        let id = null;
        const idKeys = ['ID', 'id', '№', 'ID абитуриента', 'Номер', 'Код', 'Абитуриент'];
        for (const key of idKeys) {
          if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            id = parseInt(String(row[key]).trim());
            if (!isNaN(id)) break;
          }
        }

        if (!id || isNaN(id)) {
          console.warn('Пропущена строка — нет валидного ID:', row);
          skipped++;
          errors++;
          continue;
        }

        // 2. Согласие
        let consent = 0;
        const consentKeys = ['Согласие', 'consent', 'Согласие на зачисление', 'Подписано'];
        for (const key of consentKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            const str = String(val).toLowerCase().trim();
            if (['да', 'yes', 'true', '1', 'подписано'].some(v => str.includes(v))) {
              consent = 1;
            }
            break;
          }
        }

        // 3. Приоритет
        let priority = null;
        const priKeys = ['Приоритет', 'priority', 'Номер приоритета'];
        for (const key of priKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            priority = parseInt(String(val).trim());
            if (!isNaN(priority) && priority >= 1 && priority <= 4) break;
          }
        }

        if (priority === null) {
          console.warn('Пропущена строка — нет приоритета:', row);
          skipped++;
          errors++;
          continue;
        }

        // 4. Баллы
        let physics_ict  = parseInt(row['Физика/ИКТ'] || row['Physics/ICT'] || row['phys_ict'] || 0) || 0;
        let russian      = parseInt(row['Русский язык'] || row['Russian'] || row['russian'] || 0) || 0;
        let math         = parseInt(row['Математика'] || row['Math'] || row['math'] || 0) || 0;
        let achievements = parseInt(row['Достижения'] || row['Индивидуальные достижения'] || row['Achievements'] || 0) || 0;

        const total = physics_ict + russian + math + achievements;

        // 5. Вставка / обновление абитуриента
        await connection.query(`
          INSERT INTO applicants (
            id, physics_ict, russian, math, achievements, total, consent, update_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            physics_ict   = VALUES(physics_ict),
            russian       = VALUES(russian),
            math          = VALUES(math),
            achievements  = VALUES(achievements),
            total         = VALUES(total),
            consent       = VALUES(consent),
            update_date   = VALUES(update_date)
        `, [id, physics_ict, russian, math, achievements, total, consent, date]);

        const [rc] = await connection.query('SELECT ROW_COUNT() as cnt');
        const affected = rc[0].cnt;
        if (affected === 2) updated++;
        else if (affected === 1) inserted++;

        // 6. Вставка нового приоритета (старые уже удалены → простой INSERT)
        await connection.query(`
          INSERT INTO priorities (applicant_id, program_code, priority, update_date)
          VALUES (?, ?, ?, ?)
        `, [id, program, priority, date]);

      } catch (rowErr) {
        console.error('Ошибка обработки строки:', row, rowErr.message);
        errors++;
      }
    }

    await connection.commit();

    const message = `Загрузка завершена.\n` +
                    `Вставлено новых записей: ${inserted}\n` +
                    `Обновлено существующих: ${updated}\n` +
                    `Пропущено / ошибок: ${skipped + errors}`;

    console.log(message);
    res.json({ success: true, message });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Критическая ошибка загрузки:', err);
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера при загрузке: ' + err.message
    });
  } finally {
    if (connection) connection.release();
  }
});


// Получение списков (с фильтрами)
app.get('/lists', async (req, res) => {
  const { program, date, id, consent } = req.query;

  try {
    let query = `
      SELECT
        p.applicant_id AS id,
        p.program_code AS program,
        p.priority,
        a.physics_ict,
        a.russian,
        a.math,
        a.achievements,
        a.total AS total_score,
        a.consent,
        p.update_date AS date
      FROM priorities p
      LEFT JOIN applicants a ON p.applicant_id = a.id AND p.update_date = a.update_date
      WHERE 1=1
    `;
    const params = [];

    if (program) {
      query += ' AND p.program_code = ?';
      params.push(program);
    }
    if (date) {
      query += ' AND p.update_date = ?';
      params.push(date);
    }
    if (id) {
      query += ' AND p.applicant_id = ?';
      params.push(id);
    }
    if (consent !== undefined && consent !== '') {
      query += ' AND a.consent = ?';
      params.push(parseInt(consent));
    }

    query += ' ORDER BY a.total DESC, p.applicant_id';

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка получения списков:', err);
    res.status(500).json({ error: err.message });
  }
});

// Функция симуляции зачисления с правильной логикой
async function simulateEnrollment(date, connection) {
  console.log(`=== СИМУЛЯЦИЯ ЗАЧИСЛЕНИЯ ДЛЯ ДАТЫ: ${date} ===`);

  // 1. Получаем все программы
  const [programsRows] = await connection.query('SELECT code, name, places FROM programs');
  if (programsRows.length === 0) {
    console.warn('Нет программ в БД!');
    throw new Error('В базе данных нет программ');
  }

  const programs = programsRows.map(row => ({
    code: row.code,
    name: row.name,
    places: row.places
  }));

  console.log(`Найдено программ: ${programs.length}`);

  // 2. Создаем объект для отслеживания оставшихся мест
  const placesLeft = {};
  programs.forEach(prog => {
    placesLeft[prog.code] = prog.places;
  });

  // 3. Получаем всех абитуриентов с согласием, отсортированных по баллам
  // ВАЖНО: БЕЗ DISTINCT, так как нам нужно получить все записи из applicants
  const [allApplicants] = await connection.query(`
    SELECT
      a.id,
      a.total AS total_score,
      a.consent
    FROM applicants a
    WHERE a.consent = 1
      AND a.update_date = ?
    ORDER BY a.total DESC, a.id ASC
  `, [date]);

  console.log(`Всего абитуриентов с согласием: ${allApplicants.length}`);

  if (allApplicants.length === 0) {
    console.warn('Нет абитуриентов с согласием!');
  }

  const enrolledIds = new Set();
  const enrollmentMap = new Map(); // applicant_id -> program_code

  // 4. Для каждого абитуриента (от высших баллов к низшим)
  let processedCount = 0;
  let enrolledCount = 0;
  let notEnrolledCount = 0;

  for (const applicant of allApplicants) {
    processedCount++;

    // Пропускаем, если уже зачислен (на всякий случай)
    if (enrolledIds.has(applicant.id)) {
      console.log(`⚠️ Абитуриент ${applicant.id} уже зачислен, пропускаем`);
      continue;
    }

    // 5. Получаем приоритеты этого абитуриента
    const [priorities] = await connection.query(`
      SELECT
        p.program_code,
        p.priority
      FROM priorities p
      WHERE p.applicant_id = ?
        AND p.update_date = ?
      ORDER BY p.priority ASC
    `, [applicant.id, date]);

    if (priorities.length === 0) {
      console.log(`⚠️ У абитуриента ${applicant.id} нет приоритетов`);
      notEnrolledCount++;
      continue;
    }

    // 6. Пробуем зачислить по приоритетам (от 1 к 4)
    let enrolled = false;

    for (const priority of priorities) {
      const programCode = priority.program_code;

      // Проверяем, есть ли еще места на этой программе
      if (placesLeft[programCode] > 0) {
        // Зачисляем на эту программу
        await connection.query(`
          INSERT INTO enrollment (applicant_id, program_code, priority, total_score, simulation_date)
          VALUES (?, ?, ?, ?, ?)
        `, [applicant.id, programCode, priority.priority, applicant.total_score, date]);

        enrolledIds.add(applicant.id);
        enrollmentMap.set(applicant.id, programCode);
        placesLeft[programCode]--;
        enrolled = true;
        enrolledCount++;

        console.log(`✅ Зачислен ID ${applicant.id} на ${programCode} (приоритет ${priority.priority}, баллы ${applicant.total_score})`);

        // Выходим из цикла по приоритетам - абитуриент зачислен
        break;
      }
    }

    if (!enrolled) {
      console.log(`❌ Абитуриент ${applicant.id} (${applicant.total_score} баллов) не зачислен - нет мест на приоритетах: ${priorities.map(p => `${p.program_code}(${p.priority})`).join(', ')}`);
      notEnrolledCount++;
    }
  }

  // 7. Выводим итоговую статистику
  console.log(`\n=== ИТОГИ СИМУЛЯЦИИ ===`);
  console.log(`Обработано абитуриентов: ${processedCount}`);
  console.log(`Зачислено: ${enrolledCount}`);
  console.log(`Не зачислено: ${notEnrolledCount}`);

  console.log(`\nСтатистика по программам:`);
  programs.forEach(prog => {
    const enrolledOnProgram = prog.places - placesLeft[prog.code];
    const fillPercent = (enrolledOnProgram / prog.places * 100).toFixed(1);
    console.log(`${prog.code} (${prog.name}): ${enrolledOnProgram}/${prog.places} мест (${fillPercent}%)`);
  });

  // 8. Выводим распределение по приоритетам
  console.log(`\nРаспределение зачисленных по приоритетам:`);
  const [priorityStats] = await connection.query(`
    SELECT
      priority,
      COUNT(*) as count,
      MIN(total_score) as min_score,
      MAX(total_score) as max_score,
      AVG(total_score) as avg_score
    FROM enrollment
    WHERE simulation_date = ?
    GROUP BY priority
    ORDER BY priority
  `, [date]);

    priorityStats.forEach(stat => {
        let avgScore = '—';
        if (stat.avg_score !== null && stat.avg_score !== undefined) {
            // Преобразуем avg_score в число, если это возможно
            const avgNum = Number(stat.avg_score);
            if (!isNaN(avgNum)) {
                avgScore = avgNum.toFixed(1);
            }
        }
        console.log(`Приоритет ${stat.priority}: ${stat.count} чел. (мин: ${stat.min_score || '—'}, макс: ${stat.max_score || '—'}, ср: ${avgScore})`);
    });

  // 9. Сохраняем проходные баллы
  await savePassingScores(date, connection);

  return { programs, placesLeft };
}

// Маршрут для проверки распределения по приоритетам
app.get('/debug/enrollment-priority-stats', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'Не указана дата' });
  }

  try {
    // Статистика по приоритетам
    const [priorityStats] = await pool.query(`
      SELECT
        e.priority,
        COUNT(*) as count,
        MIN(e.total_score) as min_score,
        MAX(e.total_score) as max_score,
        AVG(e.total_score) as avg_score,
        GROUP_CONCAT(DISTINCT e.program_code) as programs
      FROM enrollment e
      WHERE e.simulation_date = ?
      GROUP BY e.priority
      ORDER BY e.priority
    `, [date]);

    // Детали по каждому зачисленному
    const [enrollmentDetails] = await pool.query(`
      SELECT
        e.*,
        p.name as program_name,
        a.consent,
        pr.priority as original_priority
      FROM enrollment e
      LEFT JOIN programs p ON e.program_code = p.code
      LEFT JOIN applicants a ON e.applicant_id = a.id AND a.update_date = ?
      LEFT JOIN priorities pr ON e.applicant_id = pr.applicant_id
        AND e.program_code = pr.program_code
        AND pr.update_date = ?
      WHERE e.simulation_date = ?
      ORDER BY e.program_code, e.priority, e.total_score DESC
    `, [date, date, date]);

    // Проверяем соответствие приоритетов
    const priorityMismatch = enrollmentDetails.filter(item =>
      item.priority !== item.original_priority
    );

    res.json({
      date: date,
      total_enrolled: enrollmentDetails.length,
      priority_stats: priorityStats,
      enrollment_details: enrollmentDetails,
      priority_mismatch_count: priorityMismatch.length,
      priority_mismatch_details: priorityMismatch,
      message: `Найдено ${enrollmentDetails.length} зачисленных, распределение по приоритетам: ${priorityStats.map(p => `пр.${p.priority}:${p.count}`).join(', ')}`
    });

  } catch (err) {
    console.error('Ошибка проверки распределения:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/calculate', async (req, res) => {
  let { date } = req.query;
  date = convertDateFormat(date);
  if (!date) {
    return res.status(400).json({ error: 'Не указана дата' });
  }

  console.log(`Запрос проходных баллов для даты: ${date}`);

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Проверяем, есть ли уже рассчитанные проходные баллы за эту дату
    const [existing] = await connection.query(`
      SELECT COUNT(*) as cnt
      FROM passing_scores
      WHERE calculation_date = ?
    `, [date]);

    const alreadyCalculated = existing[0].cnt > 0;

    let passingScoresRows;

    if (alreadyCalculated) {
      console.log(`→ Данные уже есть в passing_scores → берём из базы без симуляции`);

      [passingScoresRows] = await connection.query(`
        SELECT
          ps.*,
          p.name as program_name,
          p.places as total_places
        FROM passing_scores ps
        LEFT JOIN programs p ON ps.program_code = p.code
        WHERE ps.calculation_date = ?
        ORDER BY ps.program_code
      `, [date]);
    } else {
      console.log(`→ Данных за ${date} ещё нет → запускаем симуляцию`);

      await connection.beginTransaction();

      // Очищаем только старые симуляции именно для этой даты
      await connection.query('DELETE FROM enrollment WHERE simulation_date = ?', [date]);

      // Запускаем симуляцию (она же сохранит проходные баллы через savePassingScores)
      const { programs } = await simulateEnrollment(date, connection);

      await connection.commit();

      // После симуляции получаем свежие данные
      [passingScoresRows] = await connection.query(`
        SELECT
          ps.*,
          p.name as program_name,
          p.places as total_places
        FROM passing_scores ps
        LEFT JOIN programs p ON ps.program_code = p.code
        WHERE ps.calculation_date = ?
        ORDER BY ps.program_code
      `, [date]);
    }

    // Формируем ответ в нужном формате
    const passingScores = {};
    const passingScoresTable = passingScoresRows.map(row => ({
      program_code: row.program_code,
      program_name: row.program_name || row.program_code,
      passing_score: row.passing_score,
      status: row.status,
      calculation_date: row.calculation_date,
      total_places: row.total_places
    }));

    // Совместимый старый формат
    passingScoresRows.forEach(row => {
      if (row.status === 'НЕТ ДАННЫХ') {
        passingScores[row.program_code] = 'НЕТ ДАННЫХ';
      } else if (row.status === 'НЕДОБОР') {
        passingScores[row.program_code] = 'НЕДОБОР';
      } else {
        passingScores[row.program_code] = row.passing_score ?? '—';
      }
    });

    res.json({
      passing_scores: passingScores,
      passing_scores_table: passingScoresTable,
      date: date,
      total_programs: passingScoresRows.length,
      from_cache: alreadyCalculated,   // полезно для отладки
      message: alreadyCalculated
        ? `Данные взяты из кэша (уже рассчитаны ранее)`
        : `Выполнена полная симуляция и расчёт проходных баллов`
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Ошибка в /calculate:', err);
    res.status(500).json({
      error: err.message,
      details: 'Произошла ошибка при получении/расчёте проходных баллов'
    });
  } finally {
    if (connection) connection.release();
  }
});

// Маршрут для очистки таблицы enrollment
app.post('/clear-enrollment', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query('DELETE FROM enrollment');
    res.json({ success: true, message: 'Таблица enrollment очищена' });
  } catch (err) {
    console.error('Ошибка очистки enrollment:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Маршрут для генерации PDF-отчёта с графиком И таблицей на одной странице
app.get('/report', async (req, res) => {
  let { date } = req.query;
  date = convertDateFormat(date);
  if (!date) {
    return res.status(400).send('Не указана дата');
  }

  console.log(`Генерация PDF для даты: ${date}`);

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. Проверка наличия данных
    const [enrollCheck] = await connection.query(
      'SELECT COUNT(*) as count FROM enrollment WHERE simulation_date = ?',
      [date]
    );

    if (enrollCheck[0].count === 0) {
      console.log('Нет данных в enrollment');
      return res.status(404).send('Нет данных о зачислении для указанной даты');
    }

    console.log(`Найдено записей в enrollment: ${enrollCheck[0].count}`);

    // 2. Получаем уникальные программы
    const [programsRows] = await connection.query(`
      SELECT DISTINCT
        e.program_code as code,
        COALESCE(p.name, e.program_code) as name,
        COALESCE(p.places, 0) as places
      FROM enrollment e
      LEFT JOIN programs p ON e.program_code = p.code
      WHERE e.simulation_date = ?
      ORDER BY e.program_code
    `, [date]);

    console.log(`Программ с зачислением: ${programsRows.length}`);

    // 3. Получаем исторические данные проходных баллов за последние 4 дня (от date - 3 дня до date)
    const [historicalData] = await connection.query(`
      SELECT
        ps.program_code,
        COALESCE(p.name, ps.program_code) as program_name,
        ps.passing_score,
        ps.status,
        ps.calculation_date
      FROM passing_scores ps
      LEFT JOIN programs p ON ps.program_code = p.code
      WHERE ps.calculation_date >= DATE_SUB(?, INTERVAL 3 DAY)
        AND ps.calculation_date <= ?
        AND ps.passing_score IS NOT NULL
        AND ps.status IN ('РАСЧИТАН', 'НЕДОБОР')
        AND ps.passing_score > 0
      ORDER BY ps.calculation_date ASC, ps.program_code ASC
    `, [date, date]);

    // 4. Подготовка новой таблицы проходных баллов
    const programCodes = programsRows.map(p => p.code);
    const programNames = programsRows.map(p => p.name);

    // Группируем данные по датам для таблицы
    const datesMap = new Map(); // date -> {ПМ: score, ИВТ: score, ...}

    historicalData.forEach(item => {
      const dateStr = item.calculation_date.toISOString().split('T')[0]; // YYYY-MM-DD
      const program = item.program_code;
      const score = item.passing_score;

      if (!datesMap.has(dateStr)) {
        datesMap.set(dateStr, {});
      }

      datesMap.get(dateStr)[program] = score;
    });

    // Преобразуем в массив и сортируем по дате (новые сверху)
    const datesArray = Array.from(datesMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0])) // сортируем по убыванию даты
      .slice(0, 8); // берем последние 8 записей (поменьше для одной страницы)

    console.log(`Данные для таблицы проходных баллов: ${datesArray.length} дат, ${programCodes.length} программ`);

    // 5. Группируем данные для графика
    const chartData = {};
    const datesSet = new Set();

    historicalData.forEach(item => {
      const program = item.program_code;
      const dateStr = item.calculation_date.toISOString().split('T')[0]; // YYYY-MM-DD

      if (!chartData[program]) {
        chartData[program] = {
          name: item.program_name || program,
          data: []
        };
      }

      // Сохраняем только если нет данных за эту дату или это более поздние данные
      const existingIndex = chartData[program].data.findIndex(d => d.date === dateStr);
      if (existingIndex === -1) {
        chartData[program].data.push({
          date: dateStr,
          score: item.passing_score,
          status: item.status
        });
      }

      datesSet.add(dateStr);
    });

    // Преобразуем даты в массив и сортируем
    const allDates = Array.from(datesSet).sort();

    // Если дат слишком много, берем только последние 8 (поменьше для одной страницы)
    const displayDates = allDates.length > 8 ? allDates.slice(-8) : allDates;

    console.log(`Данные для графика: ${Object.keys(chartData).length} программ, ${allDates.length} дат (показываем ${displayDates.length})`);

    // 6. Подготовка данных для итоговой таблицы
    const summaryTable = {
      headers: ['Показатель', ...programCodes],
      rows: []
    };

    const totalApplicationsRow = ['Общее кол-во заявлений'];
    const firstPriorityRow = ['Кол-во заявлений 1-го приоритета'];
    const secondPriorityRow = ['Кол-во заявлений 2-го приоритета'];
    const thirdPriorityRow = ['Кол-во заявлений 3-го приоритета'];
    const fourthPriorityRow = ['Кол-во заявлений 4-го приоритета'];
    const enrolledFirstRow = ['Кол-во зачисленных 1-го приоритета'];
    const enrolledSecondRow = ['Кол-во зачисленных 2-го приоритета'];
    const enrolledThirdRow = ['Кол-во зачисленных 3-го приоритета'];
    const enrolledFourthRow = ['Кол-во зачисленных 4-го приоритета'];
    const placesRow = ['Количество мест на ОП'];

    for (const prog of programsRows) {
      placesRow.push(prog.places.toString());

      const [totalApps] = await connection.query(`
        SELECT COUNT(*) as count
        FROM priorities
        WHERE program_code = ? AND update_date = ?
      `, [prog.code, date]);
      totalApplicationsRow.push(totalApps[0].count.toString());

      for (let priority = 1; priority <= 4; priority++) {
        const [priorityCount] = await connection.query(`
          SELECT COUNT(*) as count
          FROM priorities
          WHERE program_code = ? AND priority = ? AND update_date = ?
        `, [prog.code, priority, date]);

        switch(priority) {
          case 1: firstPriorityRow.push(priorityCount[0].count.toString()); break;
          case 2: secondPriorityRow.push(priorityCount[0].count.toString()); break;
          case 3: thirdPriorityRow.push(priorityCount[0].count.toString()); break;
          case 4: fourthPriorityRow.push(priorityCount[0].count.toString()); break;
        }
      }

      for (let priority = 1; priority <= 4; priority++) {
        const [enrolledCount] = await connection.query(`
          SELECT COUNT(*) as count
          FROM enrollment
          WHERE program_code = ? AND priority = ? AND simulation_date = ?
        `, [prog.code, priority, date]);

        switch(priority) {
          case 1: enrolledFirstRow.push(enrolledCount[0].count.toString()); break;
          case 2: enrolledSecondRow.push(enrolledCount[0].count.toString()); break;
          case 3: enrolledThirdRow.push(enrolledCount[0].count.toString()); break;
          case 4: enrolledFourthRow.push(enrolledCount[0].count.toString()); break;
        }
      }
    }

    summaryTable.rows.push(totalApplicationsRow);
    summaryTable.rows.push(placesRow);
    summaryTable.rows.push(firstPriorityRow);
    summaryTable.rows.push(secondPriorityRow);
    summaryTable.rows.push(thirdPriorityRow);
    summaryTable.rows.push(fourthPriorityRow);
    summaryTable.rows.push(enrolledFirstRow);
    summaryTable.rows.push(enrolledSecondRow);
    summaryTable.rows.push(enrolledThirdRow);
    summaryTable.rows.push(enrolledFourthRow);

    // 7. Генерация PDF
    res.contentType("application/pdf");
    res.setHeader('Content-Disposition', `attachment; filename=report_${date}.pdf`);

    const doc = new PDFDocument({
      margin: 50,
      size: 'A4'
    });

    // ПОДКЛЮЧАЕМ ШРИФТ
    const fontPath = path.join(__dirname, 'fonts', 'NotoSans-Regular.ttf');
    const fs = await import('fs');

    let fontRegistered = false;
    if (fs.existsSync(fontPath)) {
      doc.registerFont('NotoSans', fontPath);
      doc.font('NotoSans');
      fontRegistered = true;
    }

    doc.pipe(res);

    // Титульная страница
    doc.fontSize(20).text('ОТЧЕТ ПО ПОСТУПЛЕНИЮ АБИТУРИЕНТОВ', 50, 100, { align: 'center' });
    doc.fontSize(16).text(`Дата зачисления: ${date}`, 50, 150, { align: 'center' });
    doc.fontSize(14).text(`Дата формирования: ${new Date().toLocaleString('ru-RU')}`, 50, 180, { align: 'center' });

    let y = 250;

    // Детальные списки по программам
    for (const prog of programsRows) {
      const [enrolled] = await connection.query(`
        SELECT applicant_id, priority, total_score
        FROM enrollment
        WHERE program_code = ? AND simulation_date = ?
        ORDER BY total_score DESC, priority ASC, applicant_id ASC
      `, [prog.code, date]);

      if (enrolled.length > 0) {
        doc.addPage();
        if (fontRegistered) doc.font('NotoSans');
        y = 60;

        doc.fontSize(16).text(`Программа: ${prog.name} (${prog.code})`, 50, 50, { align: 'center' });
        doc.fontSize(14).text(`Зачислено: ${enrolled.length} из ${prog.places} мест`, 50, y + 30, { align: 'center' });

        y += 80;

        doc.fontSize(10).text('№', 50, y);
        doc.text('ID абитуриента', 80, y);
        doc.text('Приоритет', 180, y);
        doc.text('Сумма баллов', 250, y);

        y += 20;
        doc.moveTo(50, y).lineTo(350, y).stroke();
        y += 10;

        doc.fontSize(9);
        enrolled.forEach((item, idx) => {
          if (y > 720) {
            doc.addPage();
            if (fontRegistered) doc.font('NotoSans');
            y = 50;
          }

          doc.text((idx + 1).toString(), 50, y);
          doc.text(item.applicant_id.toString(), 80, y);
          doc.text(item.priority.toString(), 180, y);
          doc.text(item.total_score.toString(), 250, y);
          y += 18;
        });
      }
    }

    // НОВАЯ СТРАНИЦА: ГРАФИК + ТАБЛИЦА НА ОДНОЙ СТРАНИЦЕ
    if (displayDates.length >= 2 && Object.keys(chartData).length > 0 && datesArray.length > 0) {
      doc.addPage();
      if (fontRegistered) doc.font('NotoSans');
      y = 50;

      // Заголовок страницы
      doc.fontSize(18).text('Динамика и история проходных баллов', 50, y, { align: 'center' });
      y += 40;

      // Подзаголовок для графика
      doc.fontSize(14).text('Динамика проходных баллов', 50, y);
      y += 25;

      // ГРАФИК (верхняя половина страницы)
      // Ограничиваем количество программ для отображения (максимум 3 для экономии места)
      const programsToShow = Object.keys(chartData)
        .filter(code => programsRows.some(p => p.code === code))
        .slice(0, 3);

      if (programsToShow.length > 0) {
        // Создаем график
        const cellWidth = 60; // Уменьшено для экономии места
        const startX = 50;
        const startY = y + 20;
        const maxGraphHeight = 150; // Уменьшено для экономии места

        // Находим минимальный и максимальный балл для масштабирования
        let minScore = Infinity;
        let maxScore = 0;

        programsToShow.forEach(programCode => {
          const program = chartData[programCode];
          program.data.forEach(item => {
            if (displayDates.includes(item.date)) {
              if (item.score > maxScore) maxScore = item.score;
              if (item.score < minScore) minScore = item.score;
            }
          });
        });

        // Добавляем немного отступа
        minScore = Math.max(0, Math.floor(minScore * 0.9));
        maxScore = Math.ceil(maxScore * 1.1);
        const scoreRange = maxScore - minScore;

        // Рисуем оси
        doc.moveTo(startX, startY)
          .lineTo(startX, startY + maxGraphHeight)
          .stroke(); // Y-ось

        doc.moveTo(startX, startY + maxGraphHeight)
          .lineTo(startX + (cellWidth * displayDates.length), startY + maxGraphHeight)
          .stroke(); // X-ось

        // Подписи дат на оси X
        displayDates.forEach((dateStr, index) => {
          const xPos = startX + (index * cellWidth);
          const [year, month, day] = dateStr.split('-');
          const formattedDate = `${day}.${month}`;

          doc.fontSize(6)
            .text(formattedDate, xPos - 10, startY + maxGraphHeight + 3, { width: cellWidth, align: 'center' });
        });

        // Подписи баллов на оси Y
        const numSteps = 4;
        for (let i = 0; i <= numSteps; i++) {
          const scoreValue = Math.round(minScore + (scoreRange * i / numSteps));
          const yPos = startY + maxGraphHeight - (maxGraphHeight * i / numSteps);

          doc.fontSize(6)
            .text(scoreValue.toString(), startX - 25, yPos - 3, { width: 20, align: 'right' });
        }

        // Цвета для программ
        const colors = ['#FF0000', '#0000FF', '#00AA00'];

        // Рисуем линии для каждой программы
        programsToShow.forEach((programCode, programIndex) => {
          const program = chartData[programCode];
          const color = colors[programIndex % colors.length];

          // Собираем точки для этой программы
          const points = [];
          displayDates.forEach(dateStr => {
            const dataPoint = program.data.find(d => d.date === dateStr);
            if (dataPoint) {
              const xPos = startX + (displayDates.indexOf(dateStr) * cellWidth) + (cellWidth / 2);
              const scoreRatio = (dataPoint.score - minScore) / scoreRange;
              const yPos = startY + maxGraphHeight - (maxGraphHeight * scoreRatio);
              points.push({ x: xPos, y: yPos, score: dataPoint.score });
            }
          });

          // Рисуем линию, соединяющую точки
          if (points.length >= 2) {
            doc.save();
            doc.strokeColor(color);
            doc.lineWidth(1.5);

            for (let i = 0; i < points.length - 1; i++) {
              doc.moveTo(points[i].x, points[i].y)
                .lineTo(points[i + 1].x, points[i + 1].y)
                .stroke();
            }

            // Рисуем точки
            points.forEach(point => {
              doc.circle(point.x, point.y, 2)
                .fill(color);
            });

            doc.restore();
          }

          // Добавляем программу в легенду (справа от графика)
          const legendX = startX + (cellWidth * displayDates.length) + 20;
          const legendY = startY + (programIndex * 15);

          doc.fillColor(color)
            .rect(legendX, legendY, 8, 8)
            .fill();

          doc.fillColor('black')
            .fontSize(7)
            .text(program.name, legendX + 12, legendY - 1);
        });

        // Позиция после графика
        y = startY + maxGraphHeight + 50;
      } else {
        doc.fontSize(12).text('Недостаточно данных для построения графика', 50, y);
        y += 30;
      }

      // Разделительная линия между графиком и таблицей
      doc.moveTo(50, y).lineTo(550, y).stroke();
      y += 20;

      // Подзаголовок для таблицы
      doc.fontSize(14).text('История проходных баллов', 50, y);
      y += 25;

      // ТАБЛИЦА (нижняя половина страницы)
      // Создаем таблицу
      const colWidth = 55; // Уменьшено для экономии места
      const dateColWidth = 70;
      const startXTable = 50;
      const startYTable = y;

      // Первая строка: названия программ
      doc.fontSize(9).text('Дата', startXTable, startYTable);
      let x = startXTable + dateColWidth;

      for (let i = 0; i < programCodes.length; i++) {
        doc.text(programCodes[i], x, startYTable, { width: colWidth, align: 'center' });
        x += colWidth;
      }

      y = startYTable + 15;

      // Линия под заголовком
      doc.moveTo(startXTable, y).lineTo(startXTable + dateColWidth + (colWidth * programCodes.length), y).stroke();
      y += 8;

      // Данные таблицы
      doc.fontSize(8);

      // Ограничиваем количество строк для экономии места
      const maxRows = Math.min(6, datesArray.length);
      for (let i = 0; i < maxRows; i++) {
        const [dateStr, scores] = datesArray[i];

        if (y > 700) { // Проверяем, не вышли ли за пределы страницы
          break;
        }

        // Форматируем дату: DD.MM.YYYY
        const [year, month, day] = dateStr.split('-');
        const formattedDate = `${day}.${month}.${year}`;

        x = startXTable;
        doc.text(formattedDate, x, y, { width: dateColWidth - 5 });
        x += dateColWidth;

        // Данные по программам
        for (const programCode of programCodes) {
          const score = scores[programCode];
          doc.text(score ? score.toString() : '—', x, y, { width: colWidth, align: 'center' });
          x += colWidth;
        }

        y += 14;

        // Линия между строками (только если не последняя строка)
        if (i < maxRows - 1) {
          doc.moveTo(startXTable, y - 3).lineTo(startXTable + dateColWidth + (colWidth * programCodes.length), y - 3).stroke();
          y += 4;
        }
      }

      // Завершающая линия
      doc.moveTo(startXTable, y - 3).lineTo(startXTable + dateColWidth + (colWidth * programCodes.length), y - 3).stroke();

      // Если есть еще данные, показываем сообщение
      if (datesArray.length > maxRows) {
        y += 10;
        doc.fontSize(7).text(`... и еще ${datesArray.length - maxRows} записей`, startXTable, y);
      }
    }

    // Раздел: Проходные баллы по программам (текущие)
    const [passingScores] = await connection.query(`
      SELECT ps.program_code, COALESCE(p.name, ps.program_code) as name, ps.passing_score, ps.status
      FROM passing_scores ps
      LEFT JOIN programs p ON ps.program_code = p.code
      WHERE ps.calculation_date = ?
      ORDER BY ps.program_code
    `, [date]);

    if (passingScores.length > 0) {
      doc.addPage();
      if (fontRegistered) doc.font('NotoSans');
      y = 50;

      doc.fontSize(18).text('Проходные баллы на текущую дату', 50, y, { align: 'center' });
      y += 50;

      doc.fontSize(12).text('Программа', 50, y);
      doc.text('Проходной балл', 300, y);
      doc.text('Статус', 450, y);
      y += 25;

      doc.moveTo(50, y).lineTo(550, y).stroke();
      y += 15;

      doc.fontSize(10);
      passingScores.forEach((ps) => {
        if (y > 720) {
          doc.addPage();
          if (fontRegistered) doc.font('NotoSans');
          y = 50;
        }

        doc.text(`${ps.name} (${ps.program_code})`, 50, y);
        doc.text(ps.passing_score ? ps.passing_score.toString() : '—', 300, y);
        doc.text(ps.status, 450, y);
        y += 20;
      });
    }

    // РАЗДЕЛ: Итоговая таблица статистики
    doc.addPage();
    if (fontRegistered) doc.font('NotoSans');
    y = 50;

    doc.fontSize(18).text('Сводная статистика по программам', 50, y, { align: 'center' });
    y += 50;

    // Настройки таблицы
    const colWidthSummary = 60;
    const firstColWidth = 150;

    // Начальные координаты
    let x = 50;

    // Заголовки таблицы
    doc.fontSize(10).text('Показатель', x, y);
    x += firstColWidth;

    for (let i = 0; i < programCodes.length; i++) {
      doc.text(programCodes[i], x, y, { width: colWidthSummary, align: 'center' });
      x += colWidthSummary;
    }

    y += 20;

    // Линия под заголовком
    doc.moveTo(50, y).lineTo(50 + firstColWidth + (colWidthSummary * programCodes.length), y).stroke();
    y += 10;

    // Данные таблицы
    doc.fontSize(9);

    for (const row of summaryTable.rows) {
      if (y > 720) {
        doc.addPage();
        if (fontRegistered) doc.font('NotoSans');
        y = 50;
      }

      x = 50;

      // Первый столбец (название показателя)
      doc.text(row[0], x, y, { width: firstColWidth - 10 });
      x += firstColWidth;

      // Данные по программам
      for (let i = 1; i < row.length; i++) {
        doc.text(row[i], x, y, { width: colWidthSummary, align: 'center' });
        x += colWidthSummary;
      }

      y += 18;

      // Линия между строками
      if (summaryTable.rows.indexOf(row) < summaryTable.rows.length - 1) {
        doc.moveTo(50, y - 5).lineTo(50 + firstColWidth + (colWidthSummary * programCodes.length), y - 5).stroke();
        y += 5;
      }
    }

    // Завершающая линия
    doc.moveTo(50, y - 5).lineTo(50 + firstColWidth + (colWidthSummary * programCodes.length), y - 5).stroke();

    doc.end();
    console.log(`✓ PDF успешно сформирован для ${date}`);

  } catch (err) {
    console.error('Ошибка генерации PDF:', err);
    if (!res.headersSent) {
      res.status(500).send('Ошибка формирования отчёта: ' + err.message);
    }
  } finally {
    if (connection) connection.release();
  }
});

// Отладочные эндпоинты (остаются без изменений)
app.get('/debug/applicants', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, consent, total, update_date FROM applicants ORDER BY id LIMIT 50');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/priorities', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.applicant_id, p.program_code, p.priority, p.update_date, a.total, a.consent
      FROM priorities p
      LEFT JOIN applicants a ON p.applicant_id = a.id AND p.update_date = a.update_date
      ORDER BY p.priority, a.total DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Маршрут для очистки всей базы данных
app.post('/clear', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query('DELETE FROM enrollment');
    await connection.query('DELETE FROM priorities');
    await connection.query('DELETE FROM applicants');
    await connection.query('DELETE FROM passing_scores');

    await connection.commit();
    res.json({ success: true, message: 'База данных полностью очищена' });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Ошибка очистки БД:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});
app.get('/debug/counts', async (req, res) => {
  try {
    const [applicants] = await pool.query('SELECT COUNT(*) as count FROM applicants');
    const [priorities] = await pool.query('SELECT COUNT(*) as count FROM priorities');
    const [consentYes] = await pool.query('SELECT COUNT(*) as count FROM applicants WHERE consent = 1');
    const [consentNo] = await pool.query('SELECT COUNT(*) as count FROM applicants WHERE consent = 0');
    const [programs] = await pool.query('SELECT code, name, places FROM programs');

    res.json({
      applicants: applicants[0].count,
      priorities: priorities[0].count,
      with_consent: consentYes[0].count,
      without_consent: consentNo[0].count,
      programs: programs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Функция для сохранения проходных баллов в таблицу passing_scores
// Функция для сохранения проходных баллов в таблицу passing_scores
async function savePassingScores(date, connection) {
  console.log(`\n=== Сохранение проходных баллов для даты: ${date} ===`);

  // Получаем все программы
  const [programsRows] = await connection.query('SELECT code, name, places FROM programs');
  const programs = programsRows.map(row => ({
    code: row.code,
    name: row.name,
    places: row.places
  }));

  console.log(`Программ для обработки: ${programs.length}`);

  // Для каждой программы получаем статистику зачисления
  for (const prog of programs) {
    const code = prog.code;

    // Получаем статистику зачисления
    const [enrollmentStats] = await connection.query(`
      SELECT
        MIN(total_score) AS min_score,
        COUNT(*) AS enrolled_count
      FROM enrollment
      WHERE program_code = ? AND simulation_date = ?
    `, [code, date]);

    const { min_score, enrolled_count } = enrollmentStats[0] || { min_score: null, enrolled_count: 0 };

    console.log(`\nПрограмма: ${code} (${prog.name})`);
    console.log(`  Зачислено: ${enrolled_count}/${prog.places}`);
    console.log(`  Минимальный балл: ${min_score || 'нет'}`);

    // Определяем статус и проходной балл
    let passingScore = null;
    let status = 'РАСЧИТАН';

    if (enrolled_count === 0) {
      status = 'НЕТ ДАННЫХ';
      passingScore = null;
    } else if (enrolled_count < prog.places) {
      status = 'НЕДОБОР';
      passingScore = min_score;
    } else {
      status = 'РАСЧИТАН';
      passingScore = min_score;
    }

    // Используем INSERT ... ON DUPLICATE KEY UPDATE
    await connection.query(`
      INSERT INTO passing_scores (program_code, passing_score, status, calculation_date)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        passing_score = VALUES(passing_score),
        status = VALUES(status),
        created_at = CURRENT_TIMESTAMP
    `, [code, passingScore, status, date]);

    console.log(`  Статус: "${status}", Проходной балл: ${passingScore || '—'}`);
  }

  console.log(`\n✓ Проходные баллы сохранены/обновлены для ${programs.length} программ`);
}

// server.js - добавьте после других маршрутов, но перед app.listen()

// Получение списка всех уникальных абитуриентов с фильтрацией
app.get('/all-applicants', async (req, res) => {
    const { id, score, date } = req.query;

    try {
        // ИСПОЛЬЗУЕМ INNER JOIN с priorities чтобы получить только абитуриентов с приоритетами
        let query = `
            SELECT DISTINCT
                a.id,
                a.total,
                a.update_date
            FROM applicants a
            INNER JOIN priorities p ON a.id = p.applicant_id
                                   AND a.update_date = p.update_date
            WHERE 1=1
        `;
        const params = [];

        if (id) {
            query += ' AND a.id = ?';
            params.push(parseInt(id));
        }

        if (score) {
            query += ' AND a.total >= ?';
            params.push(parseInt(score));
        }

        if (date) {
            query += ' AND a.update_date = ?';
            params.push(date);
        }

        // Сортируем по сумме баллов (от большего к меньшему)
        query += ' ORDER BY a.total DESC, a.id ASC';

        console.log('SQL запрос абитуриентов:', query);
        console.log('Параметры:', params);

        const [rows] = await pool.query(query, params);

        // Обрабатываем результаты
        const processedRows = rows.map(row => ({
            id: row.id,
            total: Number(row.total) || 0,
            update_date: row.update_date
        }));

        console.log(`Найдено ${processedRows.length} уникальных абитуриентов с приоритетами`);
        res.json(processedRows);
    } catch (err) {
        console.error('Ошибка получения списка абитуриентов:', err);
        res.status(500).json({ error: err.message });
    }
});

// Получение детальной информации об абитуриенте с его приоритетами
// Получение детальной информации об абитуриенте с его приоритетами
app.get('/applicant-details', async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Не указан ID абитуриента' });
    }

    try {
        // Получаем основную информацию об абитуриенте
        const [applicantRows] = await pool.query(
            `SELECT
                a.*
            FROM applicants a
            INNER JOIN priorities p ON a.id = p.applicant_id
                                   AND a.update_date = p.update_date
            WHERE a.id = ?
            ORDER BY a.update_date DESC
            LIMIT 1`,
            [id]
        );

        if (applicantRows.length === 0) {
            return res.status(404).json({ error: 'Абитуриент не найден или не имеет приоритетов' });
        }

        // Получаем приоритеты абитуриента
        const [priorityRows] = await pool.query(`
            SELECT
                p.applicant_id,
                p.program_code,
                p.priority,
                p.update_date,
                pr.name as program_name
            FROM priorities p
            LEFT JOIN programs pr ON p.program_code = pr.code
            WHERE p.applicant_id = ?
            ORDER BY p.priority ASC, p.update_date DESC
        `, [id]);

        res.json({
            applicant: {
                ...applicantRows[0],
                consent: Boolean(applicantRows[0].consent)
            },
            priorities: priorityRows
        });

    } catch (err) {
        console.error('Ошибка получения деталей абитуриента:', err);
        res.status(500).json({ error: err.message });
    }
});

// Старт сервера
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`📁 Рабочая директория: ${__dirname}`);
});