import express from 'express';
import multer from 'multer';
import mysql from 'mysql2/promise';
import XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '55758690',  // fallback для локалки
  database: process.env.DB_NAME || 'admission_db',
  charset: 'utf8mb4', // Важно для поддержки кириллицы
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z' // Фикс проблемы с часовыми поясами при работе с датами
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  res.header('Content-Type', 'application/json; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('file'), async (req, res) => {
  let { program, date } = req.body;
  const filePath = req.file?.path;

  date = convertDateFormat(date);

  if (!program || !date || !filePath) {
    return res.status(400).json({
      success: false,
      message: 'Не указана образовательная программа, дата или файл'
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [delPrior] = await connection.query(
      'DELETE FROM priorities WHERE program_code = ?',
      [program]
    );

    const [delEnroll] = await connection.query(
      'DELETE FROM enrollment WHERE program_code = ?',
      [program]
    );

    await connection.beginTransaction();

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

    if (jsonData.length === 0) {
      throw new Error('Файл пустой или имеет неправильный формат');
    }

    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const row of jsonData) {
      try {
        let id = null;
        const idKeys = ['ID', 'id', '№', 'ID абитуриента', 'Номер', 'Код', 'Абитуриент'];

        for (const key of idKeys) {
          if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            id = parseInt(String(row[key]).trim());
            if (!isNaN(id)) break;
          }
        }

        if (!id || isNaN(id)) {
          errors++;
          continue;
        }

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
          errors++;
          continue;
        }

        const physics_ict  = parseInt(row['Физика/ИКТ'] || row['Physics/ICT'] || row['phys_ict'] || 0) || 0;
        const russian      = parseInt(row['Русский язык'] || row['Russian'] || row['russian'] || 0) || 0;
        const math         = parseInt(row['Математика'] || row['Math'] || row['math'] || 0) || 0;
        const achievements = parseInt(row['Достижения'] || row['Индивидуальные достижения'] || row['Achievements'] || 0) || 0;

        const total = physics_ict + russian + math + achievements;

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

        await connection.query(`
          INSERT INTO priorities (applicant_id, program_code, priority, update_date)
          VALUES (?, ?, ?, ?)
        `, [id, program, priority, date]);

      } catch (rowErr) {
        errors++;
      }
    }

    await connection.commit();

    res.json({
      success: true,
      message: `Загрузка завершена. Вставлено: ${inserted}, Обновлено: ${updated}, Ошибок: ${errors}`
    });

  } catch (err) {
    if (connection) await connection.rollback();
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера при загрузке: ' + err.message
    });
  } finally {
    if (connection) connection.release();
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

async function simulateEnrollment(date, connection) {
  const [programsRows] = await connection.query('SELECT code, name, places FROM programs');

  if (programsRows.length === 0) {
    throw new Error('В базе данных нет программ');
  }

  const programs = programsRows.map(row => ({
    code: row.code,
    name: row.name,
    places: row.places
  }));

  const placesLeft = {};
  programs.forEach(prog => {
    placesLeft[prog.code] = prog.places;
  });

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

  const enrolledIds = new Set();
  let enrolledCount = 0;
  let notEnrolledCount = 0;

  for (const applicant of allApplicants) {
    if (enrolledIds.has(applicant.id)) {
      continue;
    }

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
      notEnrolledCount++;
      continue;
    }

    let enrolled = false;

    for (const priority of priorities) {
      const programCode = priority.program_code;

      if (placesLeft[programCode] > 0) {
        await connection.query(`
          INSERT INTO enrollment (applicant_id, program_code, priority, total_score, simulation_date)
          VALUES (?, ?, ?, ?, ?)
        `, [applicant.id, programCode, priority.priority, applicant.total_score, date]);

        enrolledIds.add(applicant.id);
        placesLeft[programCode]--;
        enrolled = true;
        enrolledCount++;
        break;
      }
    }

    if (!enrolled) {
      notEnrolledCount++;
    }
  }

  await savePassingScores(date, connection);

  return { programs, placesLeft };
}

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

app.post('/clear-enrollment', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query('DELETE FROM enrollment');
    res.json({ success: true, message: 'Таблица enrollment очищена' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

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

    // 1. Проверка наличия данных в enrollment
    const [enrollCheck] = await connection.query(
      'SELECT COUNT(*) as count FROM enrollment WHERE simulation_date = ?',
      [date]
    );

    // Если данных нет, запускаем симуляцию зачисления
    if (enrollCheck[0].count === 0) {
      console.log('Нет данных в enrollment, запускаем симуляцию зачисления...');
      
      // Проверяем, есть ли данные о приоритетах на эту дату
      const [prioritiesCheck] = await connection.query(
        'SELECT COUNT(*) as count FROM priorities WHERE update_date = ?',
        [date]
      );

      if (prioritiesCheck[0].count === 0) {
        console.log('Нет данных о приоритетах для указанной даты');
        return res.status(404).send('Нет данных о заявлениях абитуриентов для указанной даты. Сначала загрузите файл с данными.');
      }

      // Проверяем, есть ли данные о абитуриентах с согласием на эту дату
      const [applicantsCheck] = await connection.query(
        'SELECT COUNT(*) as count FROM applicants WHERE update_date = ? AND consent = 1',
        [date]
      );

      if (applicantsCheck[0].count === 0) {
        console.log('Нет абитуриентов с согласием для указанной даты');
        return res.status(404).send('Нет абитуриентов с согласием на зачисление для указанной даты.');
      }

      // Запускаем симуляцию зачисления
      try {
        await connection.beginTransaction();
        
        // Очищаем только старые симуляции именно для этой даты
        await connection.query('DELETE FROM enrollment WHERE simulation_date = ?', [date]);
        
        // Запускаем симуляцию
        await simulateEnrollment(date, connection);
        
        await connection.commit();
        console.log(`Симуляция зачисления успешно выполнена для ${date}`);
      } catch (simulationError) {
        if (connection) await connection.rollback();
        console.error('Ошибка при симуляции зачисления:', simulationError);
        return res.status(500).send('Ошибка при выполнении симуляции зачисления: ' + simulationError.message);
      }
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

    if (programsRows.length === 0) {
      console.log('Нет программ с зачислением');
      return res.status(404).send('Нет данных о зачислении для указанной даты');
    }

    console.log(`Программ с зачислением: ${programsRows.length}`);

    // 3. Получаем исторические данные проходных баллов за последние 4 дня (от date - 3 дня до date)
    // Проверяем, есть ли данные в passing_scores, если нет - создаем их
    const [passingScoresCheck] = await connection.query(
      'SELECT COUNT(*) as count FROM passing_scores WHERE calculation_date = ?',
      [date]
    );

    if (passingScoresCheck[0].count === 0) {
      console.log('Нет данных в passing_scores, сохраняем проходные баллы...');
      await savePassingScores(date, connection);
    }

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

    // Вспомогательная функция для замены "0" на пустую строку
    const formatStatValue = (value) => {
      if (value === null || value === undefined) return '';
      
      const strValue = String(value).trim();
      
      // Проверяем, является ли значение нулем
      const numValue = parseInt(strValue, 10);
      if (numValue === 0 || strValue === '0' || strValue === '') {
        return '';
      }
      
      return strValue;
    };

    for (const prog of programsRows) {
      // Количество мест
      placesRow.push(formatStatValue(prog.places));

      // Общее количество заявлений
      const [totalApps] = await connection.query(`
        SELECT COUNT(*) as count
        FROM priorities
        WHERE program_code = ? AND update_date = ?
      `, [prog.code, date]);
      totalApplicationsRow.push(formatStatValue(totalApps[0].count));

      // Заявлений по приоритетам
      for (let priority = 1; priority <= 4; priority++) {
        const [priorityCount] = await connection.query(`
          SELECT COUNT(*) as count
          FROM priorities
          WHERE program_code = ? AND priority = ? AND update_date = ?
        `, [prog.code, priority, date]);

        const count = priorityCount[0].count;
        switch(priority) {
          case 1: firstPriorityRow.push(formatStatValue(count)); break;
          case 2: secondPriorityRow.push(formatStatValue(count)); break;
          case 3: thirdPriorityRow.push(formatStatValue(count)); break;
          case 4: fourthPriorityRow.push(formatStatValue(count)); break;
        }
      }

      // Зачисленных по приоритетам
      for (let priority = 1; priority <= 4; priority++) {
        const [enrolledCount] = await connection.query(`
          SELECT COUNT(*) as count
          FROM enrollment
          WHERE program_code = ? AND priority = ? AND simulation_date = ?
        `, [prog.code, priority, date]);

        const count = enrolledCount[0].count;
        switch(priority) {
          case 1: enrolledFirstRow.push(formatStatValue(count)); break;
          case 2: enrolledSecondRow.push(formatStatValue(count)); break;
          case 3: enrolledThirdRow.push(formatStatValue(count)); break;
          case 4: enrolledFourthRow.push(formatStatValue(count)); break;
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

    // Отладочная информация
    console.log('Сводная таблица подготовлена:');
    summaryTable.rows.forEach((row, index) => {
      const rowValues = row.slice(1).map(val => val === '' ? '[пусто]' : val);
      console.log(`  ${row[0]}: ${rowValues.join(', ')}`);
    });

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

      // Подзаголовок для таблица
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
        const cellValue = row[i];
        // Если пустая строка - ничего не отображаем
        doc.text(cellValue, x, y, { width: colWidthSummary, align: 'center' });
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
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

async function savePassingScores(date, connection) {
  const [programsRows] = await connection.query('SELECT code, name, places FROM programs');
  const programs = programsRows.map(row => ({
    code: row.code,
    name: row.name,
    places: row.places
  }));

  for (const prog of programs) {
    const code = prog.code;

    const [enrollmentStats] = await connection.query(`
      SELECT
        MIN(total_score) AS min_score,
        COUNT(*) AS enrolled_count
      FROM enrollment
      WHERE program_code = ? AND simulation_date = ?
    `, [code, date]);

    const { min_score, enrolled_count } = enrollmentStats[0] || { min_score: null, enrolled_count: 0 };

    let passingScore = null;
    let status = 'РАСЧИТАН';

    if (enrolled_count === 0) {
      status = 'НЕТ ДАННЫХ';
    } else if (enrolled_count < prog.places) {
      status = 'НЕДОБОР';
      passingScore = min_score;
    } else {
      status = 'РАСЧИТАН';
      passingScore = min_score;
    }

    await connection.query(`
      INSERT INTO passing_scores (program_code, passing_score, status, calculation_date)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        passing_score = VALUES(passing_score),
        status = VALUES(status),
        created_at = CURRENT_TIMESTAMP
    `, [code, passingScore, status, date]);
  }
}

app.get('/all-applicants', async (req, res) => {
  const { id, score, date } = req.query;

  try {
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

    query += ' ORDER BY a.total DESC, a.id ASC';

    const [rows] = await pool.query(query, params);

    const processedRows = rows.map(row => ({
      id: row.id,
      total: Number(row.total) || 0,
      update_date: row.update_date
    }));

    res.json(processedRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/applicant-details', async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Не указан ID абитуриента' });
  }

  try {
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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});