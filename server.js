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

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Настройка базы данных с поддержкой кириллицы
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z'
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

  async function executeUpload() {
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

      // Конвертируем лист в JSON
      const jsonData = XLSX.utils.sheet_to_json(worksheet, {
        raw: false,  // Обрабатываем как строки
        defval: '',  // Пустые клетки как пустая строка
        blankrows: false  // Игнорируем пустые строки
      });

      console.log('Прочитано строк из Excel:', jsonData.length);

      if (jsonData.length === 0) {
        throw new Error('Файл пустой или имеет неправильный формат');
      }

      let insertedApplicants = 0;
      let insertedPriorities = 0;

      for (const row of jsonData) {
        // Находим ID абитуриента
        let id = null;
        const idKeys = ['ID', 'id', '№', 'ID абитуриента', 'Номер', 'Код', 'Абитуриент'];

        for (const key of idKeys) {
          if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            id = parseInt(String(row[key]).trim());
            if (!isNaN(id)) break;
          }
        }

        if (!id || isNaN(id)) {
          console.warn('Пропуск строки без валидного ID:', row);
          continue;
        }

        // Согласие
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

        // Приоритет
        let priority = null;
        const priKeys = ['Приоритет', 'priority', 'Номер приоритета'];

        for (const key of priKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            priority = parseInt(String(val).trim());
            if (!isNaN(priority)) break;
          }
        }

        if (priority === null) {
          console.warn('Пропуск строки без приоритета:', id, row);
          continue;
        }

        // Баллы по предметам
        let physics_ict = 0;
        const physKeys = ['Физика/ИКТ', 'physics_ict', 'Физика', 'ИКТ'];

        for (const key of physKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            physics_ict = parseInt(String(val).trim()) || 0;
            break;
          }
        }

        let russian = 0;
        const rusKeys = ['Русский', 'russian', 'Русский язык'];

        for (const key of rusKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            russian = parseInt(String(val).trim()) || 0;
            break;
          }
        }

        let math = 0;
        const mathKeys = ['Математика', 'math', 'Матем.'];

        for (const key of mathKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            math = parseInt(String(val).trim()) || 0;
            break;
          }
        }

        let achievements = 0;
        const achKeys = ['Достижения', 'achievements', 'Индивидуальные достижения', 'ИД'];

        for (const key of achKeys) {
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            achievements = parseInt(String(val).trim()) || 0;
            break;
          }
        }

        const total = physics_ict + russian + math + achievements;

        // Вставляем или обновляем абитуриента
        await connection.query(`
          INSERT INTO applicants (id, consent, physics_ict, russian, math, achievements, total, update_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            consent = VALUES(consent),
            physics_ict = VALUES(physics_ict),
            russian = VALUES(russian),
            math = VALUES(math),
            achievements = VALUES(achievements),
            total = VALUES(total),
            update_date = VALUES(update_date)
        `, [id, consent, physics_ict, russian, math, achievements, total, date]);

        insertedApplicants++;

        // Вставляем или обновляем приоритет
        await connection.query(`
          INSERT INTO priorities (applicant_id, program_code, priority, update_date)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            priority = VALUES(priority),
            update_date = VALUES(update_date)
        `, [id, program, priority, date]);

        insertedPriorities++;
      }

      await connection.commit();

      console.log('Успешно вставлено/обновлено абитуриентов:', insertedApplicants);
      console.log('Успешно вставлено/обновлено приоритетов:', insertedPriorities);

      res.json({
        success: true,
        message: 'Данные успешно загружены и обновлены',
        insertedApplicants,
        insertedPriorities
      });

    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  try {
    let retries = MAX_RETRIES;
    while (retries > 0) {
      try {
        await executeUpload();
        break;
      } catch (err) {
        if (err.code === 'ER_LOCK_DEADLOCK') {
          retries--;
          console.warn(`Deadlock detected, retrying (${MAX_RETRIES - retries}/${MAX_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          throw err;
        }
      }
    }
    if (retries === 0) {
      throw new Error('Max retries exceeded for deadlock');
    }
  } catch (err) {
    console.error('Критическая ошибка загрузки:', err);
    res.status(500).json({
      success: false,
      message: 'Ошибка загрузки: ' + err.message
    });
  }
});

// Сброс базы данных
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

    res.json({
      success: true,
      message: 'База данных успешно очищена'
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Ошибка очистки:', err);
    res.status(500).json({
      success: false,
      message: 'Ошибка очистки базы: ' + err.message
    });
  } finally {
    if (connection) connection.release();
  }
});

// Получение конкурсных списков
app.get('/lists', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    let query = `
      SELECT
        p.applicant_id AS id,
        a.consent,
        p.priority,
        a.physics_ict,
        a.russian,
        a.math,
        a.achievements,
        a.total AS total_score,
        p.program_code AS program,
        p.update_date AS date
      FROM priorities p
      JOIN applicants a ON p.applicant_id = a.id AND p.update_date = a.update_date
      WHERE 1=1
    `;
    const params = [];

    const { program, date, id, consent } = req.query;

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
      params.push(parseInt(id));
    }

    if (consent !== undefined && consent !== '') {
      query += ' AND a.consent = ?';
      params.push(parseInt(consent));
    }

    query += ' ORDER BY a.total DESC, p.priority ASC, p.applicant_id ASC';

    const [rows] = await connection.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка загрузки списков:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Получение доступных дат
app.get('/available-dates', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT DISTINCT update_date
      FROM applicants
      ORDER BY update_date DESC
    `);
    res.json(rows.map(row => row.update_date));
  } catch (err) {
    console.error('Ошибка получения дат:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Получение доступных программ
app.get('/programs', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM programs ORDER BY code');
    res.json(rows);
  } catch (err) {
    console.error('Ошибка получения программ:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Симуляция зачисления
app.post('/simulate', async (req, res) => {
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Не указана дата симуляции' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Очищаем предыдущие записи симуляции за эту дату
    await connection.query('DELETE FROM enrollment WHERE simulation_date = ?', [date]);

    // Получаем все программы
    const [programs] = await connection.query('SELECT * FROM programs');

    let totalEnrolled = 0;

    // Для каждой программы
    for (const prog of programs) {
      const code = prog.code;
      const places = prog.places;

      // Получаем абитуриентов, подавших на эту программу с согласием
      const [applicants] = await connection.query(`
        SELECT
          p.applicant_id AS id,
          p.priority,
          a.total
        FROM priorities p
        JOIN applicants a ON p.applicant_id = a.id AND p.update_date = a.update_date
        WHERE p.program_code = ?
          AND a.consent = 1
          AND a.update_date = ?
        ORDER BY a.total DESC, p.priority ASC, p.applicant_id ASC
        LIMIT ?
      `, [code, date, places]);

      // Зачисляем
      for (const app of applicants) {
        await connection.query(`
          INSERT INTO enrollment
          (applicant_id, program_code, priority, total_score, simulation_date)
          VALUES (?, ?, ?, ?, ?)
        `, [app.id, code, app.priority, app.total, date]);

        totalEnrolled++;
      }
    }

    await connection.commit();

    res.json({
      success: true,
      message: 'Симуляция зачисления успешно завершена',
      enrolled: totalEnrolled
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Ошибка симуляции:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Расчёт проходных баллов
app.post('/calculate-passing', async (req, res) => {
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Не указана дата расчёта' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Получаем все программы
    const [programs] = await connection.query('SELECT * FROM programs');

    // Для каждой программы
    for (const prog of programs) {
      const code = prog.code;
      const places = prog.places;

      // Получаем минимальный балл среди зачисленных
      const [minScoreRows] = await connection.query(`
        SELECT MIN(total_score) as min_score
        FROM enrollment
        WHERE program_code = ? AND simulation_date = ?
      `, [code, date]);

      let status = 'НЕ ЗАЧИСЛЕНО';
      let passingScore = null;

      const min_score = minScoreRows[0].min_score;

      if (min_score === null) {
        status = 'НЕ ЗАЧИСЛЕНО';
      } else if (min_score < 0) {
        status = 'НЕ ЗАЧИСЛЕНО';
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
    }

    res.json({
      success: true,
      message: 'Проходные баллы успешно рассчитаны'
    });

  } catch (err) {
    console.error('Ошибка расчёта:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Генерация PDF отчёта
app.get('/report', async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Не указана дата отчёта' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Получаем данные о проходных баллах
    const [passingScores] = await connection.query(`
      SELECT
        ps.program_code,
        pr.name as program_name,
        ps.passing_score,
        ps.status
      FROM passing_scores ps
      JOIN programs pr ON ps.program_code = pr.code
      WHERE ps.calculation_date = ?
      ORDER BY ps.program_code
    `, [date]);

    // Получаем данные о зачислениях
    const [enrollments] = await connection.query(`
      SELECT
        e.applicant_id,
        e.program_code,
        e.priority,
        e.total_score
      FROM enrollment e
      WHERE e.simulation_date = ?
      ORDER BY e.program_code, e.total_score DESC
    `, [date]);

    // Создаём PDF
    const doc = new PDFDocument({
      size: 'A4',
      margin: { top: 50, left: 50, right: 50, bottom: 50 },
      info: {
        Title: 'Отчёт о поступлении абитуриентов',
        Author: 'Система анализа ВШЭ'
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_${date}.pdf"`);

    doc.pipe(res);

    // Шапка
    doc.fontSize(20).text('Отчёт о поступлении абитуриентов', { align: 'center' });
    doc.fontSize(14).text(`Дата: ${date}`, { align: 'center' });
    doc.moveDown(2);

    // Таблица проходных баллов
    const passingTable = {
      title: 'Проходные баллы по программам',
      headers: ['Программа', 'Название', 'Проходной балл', 'Статус'],
      rows: passingScores.map(ps => [
        ps.program_code,
        ps.program_name,
        ps.passing_score || '—',
        ps.status
      ])
    };

    await doc.table(passingTable, {
      prepareHeader: () => doc.font('Helvetica-Bold').fontSize(12),
      prepareRow: () => doc.font('Helvetica').fontSize(10)
    });

    doc.moveDown(2);

    // Таблица зачислений
    const enrollmentTable = {
      title: 'Зачисленные абитуриенты',
      headers: ['ID абитуриента', 'Программа', 'Приоритет', 'Баллы'],
      rows: enrollments.map(e => [
        e.applicant_id,
        e.program_code,
        e.priority,
        e.total_score
      ])
    };

    await doc.table(enrollmentTable, {
      prepareHeader: () => doc.font('Helvetica-Bold').fontSize(12),
      prepareRow: () => doc.font('Helvetica').fontSize(10)
    });

    doc.end();

  } catch (err) {
    console.error('Ошибка генерации отчёта:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});