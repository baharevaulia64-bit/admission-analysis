// script.js - основной файл с логикой приложения

// Глобальные переменные для сортировки
let sortColumn = null;
let sortDirection = 'asc';

// Глобальные переменные для сортировки таблицы абитуриентов
let sortApplicantColumn = null;
let sortApplicantDirection = 'asc';

// Загрузка списков абитуриентов с новым фильтром по согласию
async function loadApplicants() {
    console.log('Загрузка списков...');

    const program = document.getElementById('filterProgram').value;
    const date = document.getElementById('filterDate').value;
    const id = document.getElementById('filterID').value;
    const consent = document.getElementById('filterConsent').value;

    // Формируем URL с параметрами
    let url = '/lists?';
    if (program) url += `program=${encodeURIComponent(program)}&`;
    if (date) url += `date=${encodeURIComponent(date)}&`;
    if (id) url += `id=${encodeURIComponent(id)}&`;
    if (consent !== '') url += `consent=${encodeURIComponent(consent)}&`;

    // Убираем последний амперсанд или знак вопроса, если нет параметров
    if (url.endsWith('&') || url.endsWith('?')) {
        url = url.slice(0, -1);
    }

    if (url === '/lists?') {
        url = '/lists';
    }

    console.log('Запрос к серверу:', url);

    try {
        // Показываем индикатор загрузки
        const tbody = document.getElementById('applicantsTableBody');
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:40px;">Загрузка данных...</td></tr>';

        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Ошибка сервера:', response.status, errorText);
            throw new Error(`Сервер вернул ошибку ${response.status}: ${errorText}`);
        }

        const lists = await response.json();
        console.log('Получены данные:', lists.length, 'записей');

        // Очищаем таблицу
        tbody.innerHTML = '';

        if (!lists || lists.length === 0) {
            tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:60px 20px; color: #666; font-style: italic;">Нет данных по выбранным фильтрам</td></tr>';
            return;
        }

        // Заполняем таблицу данными
        lists.forEach((list, index) => {
            const row = document.createElement('tr');
            const hasConsent = list.consent === true || list.consent === 1;

            row.innerHTML = `
                <td>${index + 1}</td>
                <td>${list.id || '-'}</td>
                <td style="font-weight: 600; color: ${hasConsent ? '#2e7d32' : '#c62828'};">
                    ${hasConsent ? '✅ Да' : '❌ Нет'}
                </td>
                <td>${list.priority || '-'}</td>
                <td>${list.physics_ict || 0}</td>
                <td>${list.russian || 0}</td>
                <td>${list.math || 0}</td>
                <td>${list.achievements || 0}</td>
                <td style="font-weight: 600; color: var(--primary);">${list.total_score || 0}</td>
                <td>
                    <span style="display: inline-block; padding: 4px 8px; background: rgba(14, 45, 101, 0.1); border-radius: 4px; color: var(--primary); font-size: 0.9em;">
                        ${list.program || '-'}
                    </span>
                </td>
                <td>
                    ${(() => {
                        if (!list.date) return '-';
                        const date = new Date(list.date);
                        if (isNaN(date.getTime())) return list.date;
                        const day = String(date.getDate()).padStart(2, '0');
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const year = date.getFullYear();
                        return `${day}.${month}.${year}`;
                    })()}
                </td>
            `;
            tbody.appendChild(row);
        });

        console.log(`Загружено ${lists.length} записей`);

    } catch (err) {
        console.error('Ошибка загрузки списков:', err);
        const tbody = document.getElementById('applicantsTableBody');
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:40px; color: #c62828;">
            Ошибка загрузки данных:<br>
            ${err.message}
        </td></tr>`;
    }
}

// Сброс фильтров с новым полем согласия
function resetFilters() {
    document.getElementById('filterProgram').value = '';
    document.getElementById('filterDate').value = '';
    document.getElementById('filterConsent').value = '';
    document.getElementById('filterID').value = '';
    loadApplicants();
}

// Сортировка таблицы
function sortTable(colIndex) {
    const table = document.getElementById('applicantsTable');
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);

    // Переключаем направление сортировки
    if (sortColumn === colIndex) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = colIndex;
        sortDirection = 'asc';
    }

    rows.sort((a, b) => {
        let valA = a.cells[colIndex].textContent.trim();
        let valB = b.cells[colIndex].textContent.trim();

        // Специальная обработка для числовых колонок
        if (colIndex >= 4 && colIndex <= 8) { // Баллы
            valA = valA === '-' ? Infinity : parseInt(valA) || 0;
            valB = valB === '-' ? Infinity : parseInt(valB) || 0;
        } else if (colIndex === 1) {
            // Колонка "ID"
            valA = parseInt(valA) || 0;
            valB = parseInt(valB) || 0;
        }
        // Для остальных колонок (текст) используем строковое сравнение

        // Сравниваем значения
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // Очищаем и перезаполняем таблицу
    tbody.innerHTML = '';
    rows.forEach((row, index) => {
        // Обновляем номер строки
        row.cells[0].textContent = index + 1;
        tbody.appendChild(row);
    });

    // Обновляем визуальное отображение сортировки в заголовках
    const headers = table.getElementsByTagName('th');
    for (let i = 0; i < headers.length; i++) {
        headers[i].classList.remove('sort-asc', 'sort-desc');
        if (i === colIndex) {
            headers[i].classList.add(`sort-${sortDirection}`);
        }
    }
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    console.log('Страница загружена');

    // Добавляем стили для сортировки
    const style = document.createElement('style');
    style.textContent = `
        th.sort-asc::after {
            content: " ↑";
            font-weight: bold;
        }
        th.sort-desc::after {
            content: " ↓";
            font-weight: bold;
        }

        /* Стиль для ячейки с согласием */
        .consent-cell {
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 4px 8px;
            border-radius: 4px;
        }

        .consent-yes {
            background-color: rgba(76, 175, 80, 0.1);
            color: #2e7d32;
        }

        .consent-no {
            background-color: rgba(244, 67, 54, 0.1);
            color: #c62828;
        }
    `;
    document.head.appendChild(style);
});

async function calculatePassScores() {
  const dateInput = document.getElementById('calculationDate').value;

  if (!dateInput) {
    alert('Выберите дату для расчёта!');
    return;
  }

  const date = dateInput.trim();
  const resultDiv = document.getElementById('passScoresResult');

  try {
    // Показываем индикатор загрузки
    resultDiv.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;"><div class="spinner"></div><p>Расчёт проходных баллов...</p></div>';

    const response = await fetch(`/calculate?date=${encodeURIComponent(date)}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Сервер вернул ошибку: ${errorText}`);
    }

    const data = await response.json();
    console.log('Результаты расчёта:', data);

    // Формируем красивую таблицу
    let html = `
      <div style="margin-top: 20px;">
        <h3 style="color: var(--primary); margin-bottom: 15px;">📊 Результаты расчёта для даты ${date}</h3>
        <div class="table-container" style="margin-top: 15px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
            <thead>
              <tr style="background-color: rgba(14, 45, 101, 0.1);">
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid var(--primary);">Программа</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid var(--primary);">Код</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid var(--primary);">Проходной балл</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid var(--primary);">Статус</th>
              </tr>
            </thead>
            <tbody>
    `;

    if (data.passing_scores_table && data.passing_scores_table.length > 0) {
      data.passing_scores_table.forEach((item, index) => {
        // Определяем цвет статуса
        let statusColor = '#666';
        let statusIcon = '';

        if (item.status === 'РАСЧИТАН') {
          statusColor = '#2e7d32';
          statusIcon = '✅ ';
        } else if (item.status === 'НЕДОБОР') {
          statusColor = '#f57c00';
          statusIcon = '⚠️ ';
        } else if (item.status === 'НЕТ ДАННЫХ') {
          statusColor = '#c62828';
          statusIcon = '❌ ';
        }

        // Форматируем проходной балл
        let passingScoreDisplay = '—';
        if (item.passing_score !== null) {
          passingScoreDisplay = `<span style="font-weight: 600; color: var(--primary);">${item.passing_score}</span>`;
        }

        html += `
          <tr style="border-bottom: 1px solid #eee; ${index % 2 === 0 ? 'background-color: #f9f9f9;' : ''}">
            <td style="padding: 10px 12px; vertical-align: middle;">
              <div style="font-weight: 500;">${item.program_name || item.program_code}</div>
              ${item.total_places ? `<div style="font-size: 0.85em; color: #666;">Мест: ${item.total_places}</div>` : ''}
            </td>
            <td style="padding: 10px 12px; vertical-align: middle;">
              <span style="display: inline-block; padding: 4px 8px; background: rgba(14, 45, 101, 0.1); border-radius: 4px; color: var(--primary); font-size: 0.9em;">
                ${item.program_code}
              </span>
            </td>
            <td style="padding: 10px 12px; vertical-align: middle; font-size: 1.1em;">
              ${passingScoreDisplay}
            </td>
            <td style="padding: 10px 12px; vertical-align: middle;">
              <span style="color: ${statusColor}; font-weight: 500;">
                ${statusIcon}${item.status}
              </span>
            </td>
          </tr>
        `;
      });
    } else {
      html += `
        <tr>
          <td colspan="4" style="text-align: center; padding: 40px; color: #666; font-style: italic;">
            Нет данных по проходным баллам для выбранной даты
          </td>
        </tr>
      `;
    }

    html += `
            </tbody>
          </table>
        </div>
        <div style="margin-top: 20px; padding: 15px; background-color: #f5f5f5; border-radius: 8px; font-size: 0.9em; color: #555;">
          <strong>📝 Примечание:</strong>
          <ul style="margin-top: 8px; margin-left: 20px;">
            <li><span style="color: #2e7d32;">✅ РАСЧИТАН</span> — все места заполнены, проходной балл рассчитан</li>
            <li><span style="color: #f57c00;">⚠️ НЕДОБОР</span> — не все места заполнены (есть свободные места)</li>
            <li><span style="color: #c62828;">❌ НЕТ ДАННЫХ</span> — нет абитуриентов с согласием на зачисление</li>
          </ul>
        </div>
      </div>
    `;

    resultDiv.innerHTML = html;

    // Также показываем старый алерт для обратной совместимости
    alert(`Расчёт завершён для даты ${date}.\nОбработано программ: ${data.total_programs || 0}\n${data.message || ''}`);

  } catch (err) {
    console.error('Ошибка расчёта:', err);
    resultDiv.innerHTML = `
      <div style="text-align: center; padding: 30px; color: #c62828; background-color: rgba(198, 40, 40, 0.05); border-radius: 8px; margin-top: 20px;">
        <div style="font-size: 3em; margin-bottom: 10px;">❌</div>
        <h3 style="margin-bottom: 10px;">Ошибка расчёта</h3>
        <p>${err.message}</p>
      </div>
    `;
    alert('Ошибка: ' + err.message);
  }
}

// Генерация PDF (для кнопки "Сформировать PDF-отчёт")
async function generatePDF() {
  const dateInput = document.getElementById('reportDate').value;

  if (!dateInput) {
    alert('Выберите дату отчёта!');
    return;
  }

  // dateInput уже в формате YYYY-MM-DD (из <input type="date">)
  console.log('Клиент отправляет дату в PDF:', dateInput);

  // Открываем отчёт с параметром date
  window.open(`/report?date=${encodeURIComponent(dateInput)}`, '_blank');

  // Опционально: сообщение пользователю
  alert(`Формируем PDF-отчёт для даты: ${dateInput}`);
}

// Функция для очистки таблицы enrollment (для отладки)
async function clearEnrollment() {
  if (!confirm('Очистить таблицу enrollment? Это не повлияет на основные данные.')) {
    return;
  }

  try {
    const response = await fetch('/clear-enrollment', {
      method: 'POST'
    });

    if (response.ok) {
      alert('Таблица enrollment очищена');
    } else {
      const error = await response.text();
      alert('Ошибка: ' + error);
    }
  } catch (err) {
    console.error('Ошибка очистки enrollment:', err);
    alert('Ошибка: ' + err.message);
  }
}

// Загрузка списка
async function uploadList() {
    const program = document.getElementById('uploadProgram').value;
    const date = document.getElementById('uploadDate').value;
    const fileInput = document.getElementById('uploadFile');

    if (!program || !date || !fileInput.files[0]) {
        alert('Заполните все поля!');
        return;
    }

    const formData = new FormData();
    formData.append('program', program);
    formData.append('date', date);
    formData.append('file', fileInput.files[0]);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.success) {
            alert(result.message);
            // Сбрасываем форму
            document.getElementById('uploadProgram').value = '';
            document.getElementById('uploadDate').value = '';
            document.getElementById('uploadFile').value = '';
        } else {
            alert('Ошибка: ' + result.message);
        }
    } catch (err) {
        console.error('Ошибка загрузки:', err);
        alert('Ошибка загрузки: ' + err.message);
    }
}

// Очистка базы данных
async function clearDatabase() {
    if (!confirm('ВНИМАНИЕ! Вы действительно хотите очистить всю базу данных? Это действие необратимо.')) {
        return;
    }

    try {
        const response = await fetch('/clear', {
            method: 'POST'
        });

        if (response.ok) {
            const result = await response.json();
            alert(result.message);
        } else {
            const error = await response.text();
            alert('Ошибка: ' + error);
        }
    } catch (err) {
        console.error('Ошибка очистки:', err);
        alert('Ошибка очистки: ' + err.message);
    }
}

// Функция для проверки распределения по приоритетам
async function checkPriorityStats() {
  try {
    const date = document.getElementById('reportDate').value;
    if (!date) {
      alert('Выберите дату для проверки');
      return;
    }

    const response = await fetch(`/debug/enrollment-priority-stats?date=${encodeURIComponent(date)}`);
    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();
    console.log('Статистика по приоритетам:', data);

    // Формируем отчет
    let html = `
      <div style="margin-top: 20px; padding: 20px; background-color: #f8f9fa; border-radius: 8px; border-left: 4px solid var(--primary);">
        <h4 style="margin-top: 0; color: var(--primary);">📊 Статистика по приоритетам</h4>
        <p><strong>Дата:</strong> ${date}</p>
        <p><strong>Всего зачислено:</strong> ${data.total_enrolled}</p>

        <table style="width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 0.9em;">
          <thead>
            <tr style="background-color: rgba(14, 45, 101, 0.1);">
              <th style="padding: 10px; border: 1px solid #ddd;">Приоритет</th>
              <th style="padding: 10px; border: 1px solid #ddd;">Кол-во</th>
              <th style="padding: 10px; border: 1px solid #ddd;">Мин. балл</th>
              <th style="padding: 10px; border: 1px solid #ddd;">Макс. балл</th>
              <th style="padding: 10px; border: 1px solid #ddd;">Ср. балл</th>
              <th style="padding: 10px; border: 1px solid #ddd;">Программы</th>
            </tr>
          </thead>
          <tbody>
    `;

    data.priority_stats.forEach(stat => {
      const avgScore = stat.avg_score ? stat.avg_score.toFixed(1) : '—';
      html += `
        <tr>
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center; font-weight: 600;">${stat.priority}</td>
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${stat.count}</td>
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${stat.min_score || '—'}</td>
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${stat.max_score || '—'}</td>
          <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${avgScore}</td>
          <td style="padding: 10px; border: 1px solid #ddd;">${stat.programs || '—'}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
    `;

    if (data.priority_mismatch_count > 0) {
      html += `
        <div style="margin-top: 15px; padding: 10px; background-color: #fff3cd; border-radius: 4px; border-left: 4px solid #ffc107;">
          <p style="margin: 0; color: #856404;">
            <strong>⚠️ Внимание:</strong> Найдено ${data.priority_mismatch_count} несоответствий приоритетов
          </p>
        </div>
      `;
    }

    html += `
        <div style="margin-top: 15px;">
          <button onclick="viewDetailedPriorityStats('${date}')" class="btn btn-secondary" style="font-size: 0.9em;">
            📋 Подробная статистика
          </button>
        </div>
      </div>
    `;

    // Добавляем на страницу
    const resultDiv = document.getElementById('passScoresResult');
    if (resultDiv) {
      const existingContent = resultDiv.innerHTML;
      resultDiv.innerHTML = html + existingContent;
    }

    alert(`Проверка завершена!\n\nВсего зачислено: ${data.total_enrolled}\nРаспределение по приоритетам:\n${data.priority_stats.map(p => `  Приоритет ${p.priority}: ${p.count} чел.`).join('\n')}`);

  } catch (err) {
    console.error('Ошибка проверки статистики:', err);
    alert('Ошибка: ' + err.message);
  }
}

// Функция для просмотра детальной статистики
async function viewDetailedPriorityStats(date) {
  try {
    const response = await fetch(`/debug/enrollment-priority-stats?date=${encodeURIComponent(date)}`);
    const data = await response.json();

    const detailsWindow = window.open('', '_blank');
    detailsWindow.document.write(`
      <html>
        <head>
          <title>Детальная статистика по приоритетам - ${date}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
            h1 { color: #0e2d65; }
            table { border-collapse: collapse; width: 100%; margin: 20px 0; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            .priority-1 { background-color: #e8f5e8; }
            .priority-2 { background-color: #fff3cd; }
            .priority-3 { background-color: #ffe6e6; }
            .priority-4 { background-color: #e6f3ff; }
            .mismatch { background-color: #ffcccc !important; }
          </style>
        </head>
        <body>
          <h1>📊 Детальная статистика по приоритетам на ${date}</h1>
          <p>Всего зачислено: ${data.total_enrolled}</p>

          <h2>Список зачисленных</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Программа</th>
                <th>Приоритет при зачислении</th>
                <th>Оригинальный приоритет</th>
                <th>Баллы</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              ${data.enrollment_details.map(item => {
                const priorityClass = `priority-${item.priority}`;
                const mismatchClass = item.priority !== item.original_priority ? 'mismatch' : '';
                const status = item.priority === item.original_priority ? '✅ Совпадает' : '⚠️ Не совпадает';

                return `
                  <tr class="${priorityClass} ${mismatchClass}">
                    <td>${item.applicant_id}</td>
                    <td>${item.program_name} (${item.program_code})</td>
                    <td><strong>${item.priority}</strong></td>
                    <td>${item.original_priority || '—'}</td>
                    <td><strong>${item.total_score}</strong></td>
                    <td>${status}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>

          ${data.priority_mismatch_count > 0 ? `
            <h2 style="color: #dc3545;">⚠️ Несоответствия приоритетов (${data.priority_mismatch_count})</h2>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Программа</th>
                  <th>Приоритет при зачислении</th>
                  <th>Оригинальный приоритет</th>
                  <th>Разница</th>
                </tr>
              </thead>
              <tbody>
                ${data.priority_mismatch_details.map(item => `
                  <tr style="background-color: #ffcccc;">
                    <td>${item.applicant_id}</td>
                    <td>${item.program_name} (${item.program_code})</td>
                    <td><strong>${item.priority}</strong></td>
                    <td><strong>${item.original_priority}</strong></td>
                    <td>${item.priority - item.original_priority}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : ''}
        </body>
      </html>
    `);
    detailsWindow.document.close();

  } catch (err) {
    console.error('Ошибка открытия детальной статистики:', err);
    alert('Ошибка: ' + err.message);
  }
}

// Функция для отладки фильтров (можно использовать в консоли браузера)
window.testFilters = async function() {
    console.log('=== Тестирование фильтров ===');

    try {
        // Тест 1: Все записи
        console.log('1. Запрос всех записей:');
        const all = await fetch('/lists').then(r => r.json());
        console.log(`   Всего записей: ${all.length}`);
        console.log(`   С согласием: ${all.filter(a => a.consent).length}`);
        console.log(`   Без согласия: ${all.filter(a => !a.consent).length}`);

        // Тест 2: Только с согласием
        console.log('\n2. Запрос только с согласием:');
        const withConsent = await fetch('/lists?consent=1').then(r => r.json());
        console.log(`   Записей: ${withConsent.length}`);
        console.log(`   Пример: ${JSON.stringify(withConsent[0] || 'нет данных')}`);

        // Тест 3: Только без согласия
        console.log('\n3. Запрос только без согласия:');
        const withoutConsent = await fetch('/lists?consent=0').then(r => r.json());
        console.log(`   Записей: ${withoutConsent.length}`);
        console.log(`   Пример: ${JSON.stringify(withoutConsent[0] || 'нет данных')}`);

        // Тест 4: Статистика базы
        console.log('\n4. Статистика базы данных:');
        const stats = await fetch('/debug/counts').then(r => r.json());
        console.log(`   Всего абитуриентов: ${stats.applicants}`);
        console.log(`   Всего приоритетов: ${stats.priorities}`);
        console.log(`   С согласием: ${stats.with_consent}`);
        console.log(`   Без согласия: ${stats.without_consent}`);

        console.log('\n=== Тест завершен ===');

    } catch (error) {
        console.error('Ошибка при тестировании:', error);
    }
};

// ============ ФУНКЦИИ ДЛЯ ТАБЛИЦЫ АБИТУРИЕНТОВ ============

// Загрузка всех абитуриентов с фильтрацией
// Загрузка всех абитуриентов с фильтрацией
async function loadAllApplicants() {
    console.log('Загрузка списка абитуриентов...');

    const id = document.getElementById('applicantFilterID').value;
    const score = document.getElementById('applicantFilterScore').value;
    const date = document.getElementById('applicantFilterDate').value;

    // Формируем URL с параметрами
    let url = '/all-applicants?';
    if (id) url += `id=${encodeURIComponent(id)}&`;
    if (score) url += `score=${encodeURIComponent(score)}&`;
    if (date) url += `date=${encodeURIComponent(date)}&`;

    // Убираем последний амперсанд или знак вопроса
    if (url.endsWith('&') || url.endsWith('?')) {
        url = url.slice(0, -1);
    }

    if (url === '/all-applicants?') {
        url = '/all-applicants';
    }

    console.log('Запрос списка абитуриентов:', url);

    try {
        // Показываем индикатор загрузки
        const tbody = document.getElementById('allApplicantsTableBody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px;">Загрузка данных...</td></tr>';

        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Ошибка сервера:', response.status, errorText);
            throw new Error(`Сервер вернул ошибку ${response.status}: ${errorText}`);
        }

        const applicants = await response.json();
        console.log('Получены данные абитуриентов с приоритетами:', applicants.length, 'записей');

        // Очищаем таблицу
        tbody.innerHTML = '';

        if (!applicants || applicants.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:60px 20px; color: #666; font-style: italic;">Нет данных по выбранным фильтрам</td></tr>';
            return;
        }

        // Заполняем таблицу данными с порядковым номером
        applicants.forEach((applicant, index) => {
            const row = document.createElement('tr');

            row.innerHTML = `
                <td>${index + 1}</td> <!-- Порядковый номер -->
                <td>${applicant.id || '-'}</td> <!-- ID абитуриента -->
                <td style="font-weight: 600; color: var(--primary);">${applicant.total || 0}</td> <!-- Сумма баллов -->
                <td>
                    ${(() => {
                        if (!applicant.update_date) return '-';
                        const date = new Date(applicant.update_date);
                        if (isNaN(date.getTime())) return applicant.update_date;
                        const day = String(date.getDate()).padStart(2, '0');
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const year = date.getFullYear();
                        return `${day}.${month}.${year}`;
                    })()}
                </td> <!-- Дата заявления -->
                <td>
                    <button class="btn btn-small btn-secondary" onclick="viewApplicantDetails(${applicant.id})">
                        📋 Детали
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });

        console.log(`Загружено ${applicants.length} уникальных абитуриентов с приоритетами`);

    } catch (err) {
        console.error('Ошибка загрузки абитуриентов:', err);
        const tbody = document.getElementById('allApplicantsTableBody');
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:40px; color: #c62828;">
            Ошибка загрузки данных:<br>
            ${err.message}
        </td></tr>`;
    }
}

// Сортировка таблицы абитуриентов (упрощенная для 4 столбцов)
function sortApplicantsTable(colIndex) {
    const table = document.getElementById('allApplicantsTable');
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);

    // Пропускаем сортировку если нет данных или строка "нет данных"
    if (rows.length === 0 || rows[0].cells[0].textContent.includes('Нет данных')) {
        return;
    }

    // Переключаем направление сортировки
    if (sortApplicantColumn === colIndex) {
        sortApplicantDirection = sortApplicantDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortApplicantColumn = colIndex;
        sortApplicantDirection = 'asc';
    }

    rows.sort((a, b) => {
        let valA = a.cells[colIndex].textContent.trim();
        let valB = b.cells[colIndex].textContent.trim();

        // Специальная обработка для числовых колонок
        if (colIndex === 1) { // ID
            valA = parseInt(valA) || 0;
            valB = parseInt(valB) || 0;
        } else if (colIndex === 2) { // Сумма баллов
            valA = valA === '-' ? 0 : parseInt(valA) || 0;
            valB = valB === '-' ? 0 : parseInt(valB) || 0;
        } else if (colIndex === 3) { // Дата - конвертируем в timestamp
            if (valA === '-') valA = 0;
            else {
                const parts = valA.split('.');
                if (parts.length === 3) {
                    valA = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
                }
            }
            if (valB === '-') valB = 0;
            else {
                const parts = valB.split('.');
                if (parts.length === 3) {
                    valB = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
                }
            }
        }
        // Порядковый номер (colIndex === 0) не сортируем

        // Сравниваем значения
        if (valA < valB) return sortApplicantDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortApplicantDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // Очищаем и перезаполняем таблицу, обновляем порядковые номера
    tbody.innerHTML = '';
    rows.forEach((row, index) => {
        // Обновляем порядковый номер
        row.cells[0].textContent = index + 1;
        tbody.appendChild(row);
    });

    // Обновляем визуальное отображение сортировки в заголовках
    const headers = table.getElementsByTagName('th');
    for (let i = 0; i < headers.length; i++) {
        headers[i].classList.remove('sort-asc', 'sort-desc');
        if (i === colIndex) {
            headers[i].classList.add(`sort-${sortApplicantDirection}`);
        }
    }
}

// Сброс фильтров для таблицы абитуриентов
function resetApplicantFilters() {
    document.getElementById('applicantFilterID').value = '';
    document.getElementById('applicantFilterScore').value = '';
    document.getElementById('applicantFilterDate').value = '';
    loadAllApplicants();
}

// Сортировка таблицы абитуриентов
function sortApplicantsTable(colIndex) {
    const table = document.getElementById('allApplicantsTable');
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);

    // Пропускаем сортировку если нет данных или строка "нет данных"
    if (rows.length === 0 || rows[0].cells[0].textContent.includes('Нет данных')) {
        return;
    }

    // Переключаем направление сортировки
    if (sortApplicantColumn === colIndex) {
        sortApplicantDirection = sortApplicantDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortApplicantColumn = colIndex;
        sortApplicantDirection = 'asc';
    }

    rows.sort((a, b) => {
        let valA = a.cells[colIndex].textContent.trim();
        let valB = b.cells[colIndex].textContent.trim();

        // Специальная обработка для числовых колонок
        if (colIndex === 1) { // ID (теперь это 1-я колонка после порядкового номера)
            valA = parseInt(valA) || 0;
            valB = parseInt(valB) || 0;
        } else if (colIndex >= 3 && colIndex <= 7) { // Баллы (Физ/ИКТ, Русский, Математика, Достижения, Сумма)
            valA = valA === '-' ? 0 : parseInt(valA) || 0;
            valB = valB === '-' ? 0 : parseInt(valB) || 0;
        } else if (colIndex === 2) { // Согласие - сортируем по значению (Да/Нет)
            valA = valA.includes('Да') ? 1 : 0;
            valB = valB.includes('Да') ? 1 : 0;
        } else if (colIndex === 8) { // Дата - конвертируем в timestamp
            if (valA === '-') valA = 0;
            else {
                const parts = valA.split('.');
                if (parts.length === 3) {
                    valA = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
                }
            }
            if (valB === '-') valB = 0;
            else {
                const parts = valB.split('.');
                if (parts.length === 3) {
                    valB = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
                }
            }
        }
        // Порядковый номер (colIndex === 0) не сортируем - он всегда должен отображать позицию

        // Сравниваем значения
        if (valA < valB) return sortApplicantDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortApplicantDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // Очищаем и перезаполняем таблицу, обновляем порядковые номера
    tbody.innerHTML = '';
    rows.forEach((row, index) => {
        // Обновляем порядковый номер
        row.cells[0].textContent = index + 1;
        tbody.appendChild(row);
    });

    // Обновляем визуальное отображение сортировки в заголовках
    const headers = table.getElementsByTagName('th');
    for (let i = 0; i < headers.length; i++) {
        headers[i].classList.remove('sort-asc', 'sort-desc');
        if (i === colIndex) {
            headers[i].classList.add(`sort-${sortApplicantDirection}`);
        }
    }
}

// Просмотр детальной информации об абитуриенте
async function viewApplicantDetails(applicantId) {
    try {
        const response = await fetch(`/applicant-details?id=${encodeURIComponent(applicantId)}`);
        if (!response.ok) {
            throw new Error('Ошибка загрузки данных');
        }

        const data = await response.json();

        // Открываем модальное окно с деталями
        const modal = window.open('', '_blank');
        modal.document.write(`
            <html>
                <head>
                    <title>Детали абитуриента #${applicantId}</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        h1 { color: #0e2d65; }
                        .info-table { border-collapse: collapse; width: 100%; margin: 20px 0; }
                        .info-table th, .info-table td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                        .info-table th { background-color: #f2f2f2; }
                        .priority-table { margin-top: 30px; }
                        .consent-yes { color: #2e7d32; font-weight: bold; }
                        .consent-no { color: #c62828; font-weight: bold; }
                    </style>
                </head>
                <body>
                    <h1>Абитуриент #${applicantId}</h1>

                    <h2>Основная информация</h2>
                    <table class="info-table">
                        <tr>
                            <th>Показатель</th>
                            <th>Значение</th>
                        </tr>
                        <tr>
                            <td>Согласие на зачисление</td>
                            <td class="${data.applicant.consent ? 'consent-yes' : 'consent-no'}">
                                ${data.applicant.consent ? '✅ Да' : '❌ Нет'}
                            </td>
                        </tr>
                        <tr>
                            <td>Физика/ИКТ</td>
                            <td>${data.applicant.physics_ict || 0}</td>
                        </tr>
                        <tr>
                            <td>Русский язык</td>
                            <td>${data.applicant.russian || 0}</td>
                        </tr>
                        <tr>
                            <td>Математика</td>
                            <td>${data.applicant.math || 0}</td>
                        </tr>
                        <tr>
                            <td>Достижения</td>
                            <td>${data.applicant.achievements || 0}</td>
                        </tr>
                        <tr>
                            <td><strong>Общая сумма</strong></td>
                            <td><strong>${data.applicant.total || 0}</strong></td>
                        </tr>
                        <tr>
                            <td>Дата обновления</td>
                            <td>${data.applicant.update_date || '-'}</td>
                        </tr>
                    </table>

                    <h2>Приоритеты</h2>
                    ${data.priorities.length > 0 ? `
                        <table class="info-table priority-table">
                            <tr>
                                <th>Программа</th>
                                <th>Приоритет</th>
                                <th>Дата заявления</th>
                            </tr>
                            ${data.priorities.map(p => `
                                <tr>
                                    <td>${p.program_code} (${p.program_name || p.program_code})</td>
                                    <td>${p.priority}</td>
                                    <td>${p.update_date || '-'}</td>
                                </tr>
                            `).join('')}
                        </table>
                    ` : '<p>Нет данных о приоритетах</p>'}
                </body>
            </html>
        `);
        modal.document.close();

    } catch (err) {
        console.error('Ошибка загрузки деталей абитуриента:', err);
        alert('Ошибка загрузки деталей: ' + err.message);
    }
}

// ============ ДОБАВЛЕНИЕ ФУНКЦИЙ В ГЛОБАЛЬНУЮ ОБЛАСТЬ ВИДИМОСТИ ============

window.loadAllApplicants = loadAllApplicants;
window.resetApplicantFilters = resetApplicantFilters;
window.sortApplicantsTable = sortApplicantsTable;
window.viewApplicantDetails = viewApplicantDetails;
window.checkPriorityStats = checkPriorityStats;
window.viewDetailedPriorityStats = viewDetailedPriorityStats;
window.clearEnrollment = clearEnrollment;
window.testFilters = testFilters;

// Автозагрузка при загрузке страницы
window.addEventListener('load', function() {
    console.log('Страница полностью загружена');
    // Принудительно загружаем данные для страницы списков
    const path = window.location.pathname;
    if (path === '/' || path === '/index.html' || document.getElementById('applicantsTableBody')) {
        loadApplicants();
    }
});