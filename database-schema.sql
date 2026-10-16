CREATE DATABASE IF NOT EXISTS teacher_load_manager
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE teacher_load_manager;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(254) NULL UNIQUE,
  username VARCHAR(40) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'teacher') NOT NULL DEFAULT 'teacher',
  teacher_id CHAR(36) NOT NULL UNIQUE,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS school_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  data_json LONGTEXT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT school_state_singleton CHECK (id = 1)
) ENGINE=InnoDB;

INSERT INTO school_state (id, data_json)
VALUES (
  1,
  '{"teachers":[],"loads":[],"substitutionPlans":[],"leaveApplications":[],"settings":{}}'
)
ON DUPLICATE KEY UPDATE id = VALUES(id);
