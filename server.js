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
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'database',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z'
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

  let connection;
  try {
    connection = await pool.getConnection();

    const [existing] = await connection.query(`
      SELECT COUNT(*) as cnt
      FROM passing_scores
      WHERE calculation_date = ?
    `, [date]);

    const alreadyCalculated = existing[0].cnt > 0;

    let passingScoresRows;

    if (alreadyCalculated) {
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
      await connection.beginTransaction();

      await connection.query('DELETE FROM enrollment WHERE simulation_date = ?', [date]);

      const { programs } = await simulateEnrollment(date, connection);

      await connection.commit();

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

    const passingScores = {};
    const passingScoresTable = passingScoresRows.map(row => ({
      program_code: row.program_code,
      program_name: row.program_name || row.program_code,
      passing_score: row.passing_score,
      status: row.status,
      calculation_date: row.calculation_date,
      total_places: row.total_places
    }));

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
      from_cache: alreadyCalculated,
      message: alreadyCalculated
        ? `Данные взяты из кэша (уже рассчитаны ранее)`
        : `Выполнена полная симуляция и расчёт проходных баллов`
    });

  } catch (err) {
    if (connection) await connection.rollback();
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

  let connection;
  try {
    connection = await pool.getConnection();

    const [enrollCheck] = await connection.query(
      'SELECT COUNT(*) as count FROM enrollment WHERE simulation_date = ?',
      [date]
    );

    if (enrollCheck[0].count === 0) {
      return res.status(404).send('Нет данных о зачислении для указанной даты');
    }

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

    res.contentType("application/pdf");
    res.setHeader('Content-Disposition', `attachment; filename=report_${date}.pdf`);

    const doc = new PDFDocument({
      margin: 50,
      size: 'A4'
    });

    const fontPath = path.join(__dirname, 'fonts', 'NotoSans-Regular.ttf');
    const fs = await import('fs');

    let fontRegistered = false;
    if (fs.existsSync(fontPath)) {
      doc.registerFont('NotoSans', fontPath);
      doc.font('NotoSans');
      fontRegistered = true;
    }

    doc.pipe(res);

    doc.fontSize(20).text('ОТЧЕТ ПО ПОСТУПЛЕНИЮ АБИТУРИЕНТОВ', 50, 100, { align: 'center' });
    doc.fontSize(16).text(`Дата зачисления: ${date}`, 50, 150, { align: 'center' });
    doc.fontSize(14).text(`Дата формирования: ${new Date().toLocaleString('ru-RU')}`, 50, 180, { align: 'center' });

    let y = 250;

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

    doc.end();

  } catch (err) {
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