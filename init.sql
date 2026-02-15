-- init.sql
-- Полная инициализация базы данных admission_db
-- Выполняется автоматически при первом запуске контейнера MySQL

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------
-- 1. Направления подготовки (programs) — создаём первой, на неё ссылаются все
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `programs` (
  `code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `places` int NOT NULL COMMENT 'количество бюджетных мест',
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `programs` (`code`, `name`, `places`) VALUES
('IB',   'Информационная безопасность',                  20),
('ITSS', 'Инфокоммуникац. тех. и системы связи',          30),
('IVT',  'Информатика и вычислительная техника',           50),
('PM',   'Прикладная математика',                          40);

-- ----------------------------------------------------------------------
-- 2. Абитуриенты (основная информация)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `applicants` (
  `id` int NOT NULL COMMENT 'номер личного дела / ID абитуриента',
  `consent` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'наличие согласия на зачисление',
  `physics_ict` int NOT NULL DEFAULT 0 COMMENT 'Физика или ИКТ',
  `russian` int NOT NULL DEFAULT 0 COMMENT 'Русский язык',
  `math` int NOT NULL DEFAULT 0 COMMENT 'Математика',
  `achievements` int NOT NULL DEFAULT 0 COMMENT 'Индивидуальные достижения',
  `total` int NOT NULL COMMENT 'Суммарный балл',
  `update_date` date NOT NULL COMMENT 'Дата актуальности записи',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------
-- 3. Заявления / приоритеты
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `priorities` (
  `applicant_id` int NOT NULL,
  `program_code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority` tinyint UNSIGNED NOT NULL COMMENT '1–4',
  `update_date` date NOT NULL COMMENT 'дата подачи или изменения заявления',
  PRIMARY KEY (`applicant_id`, `program_code`, `update_date`),
  KEY `idx_program_code` (`program_code`),
  CONSTRAINT `chk_priority` CHECK (`priority` BETWEEN 1 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------
-- 4. Моделирование зачисления (результаты симуляции)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `enrollment` (
  `applicant_id` int NOT NULL,
  `program_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority` tinyint UNSIGNED NOT NULL,
  `total_score` smallint UNSIGNED NOT NULL,
  `simulation_date` date NOT NULL COMMENT 'дата моделирования',
  PRIMARY KEY (`applicant_id`, `simulation_date`),
  KEY `idx_program_date_score` (`program_code`, `simulation_date`, `total_score` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------
-- 5. Проходные баллы (итоговый расчёт)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `passing_scores` (
  `id` int NOT NULL AUTO_INCREMENT,
  `program_code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `passing_score` int DEFAULT NULL COMMENT 'проходной / минимальный среди зачисленных',
  `status` enum('РАСЧИТАН','НЕДОБОР','НЕТ ДАННЫХ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'РАСЧИТАН',
  `calculation_date` date NOT NULL COMMENT 'дата, на которую сделан расчёт',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_program_calc_date` (`program_code`, `calculation_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------
-- Добавляем FOREIGN KEY после создания всех таблиц (чтобы избежать проблем с порядком)
-- ----------------------------------------------------------------------
ALTER TABLE `priorities`
  ADD CONSTRAINT `fk_priorities_applicant` FOREIGN KEY (`applicant_id`)   REFERENCES `applicants` (`id`)   ON DELETE CASCADE,
  ADD CONSTRAINT `fk_priorities_program`   FOREIGN KEY (`program_code`)   REFERENCES `programs`  (`code`) ON DELETE CASCADE;

ALTER TABLE `enrollment`
  ADD CONSTRAINT `fk_enrollment_applicant` FOREIGN KEY (`applicant_id`)   REFERENCES `applicants` (`id`)   ON DELETE CASCADE,
  ADD CONSTRAINT `fk_enrollment_program`   FOREIGN KEY (`program_code`)   REFERENCES `programs`  (`code`) ON DELETE CASCADE;

ALTER TABLE `passing_scores`
  ADD CONSTRAINT `fk_passing_program` FOREIGN KEY (`program_code`) REFERENCES `programs` (`code`) ON DELETE CASCADE;

-- Восстанавливаем проверки
SET FOREIGN_KEY_CHECKS = 1;