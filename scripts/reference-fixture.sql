-- Reference fixture used only to generate native mysqldump output for study.
-- Deliberately exercises every construct the renderer and restore parser must
-- handle: circular FKs, generated columns, every data-type family, a nested
-- view, a multi-statement trigger, a procedure containing semicolons, a
-- function, and an event.

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE `authors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `nickname` varchar(120) DEFAULT NULL,
  `favourite_book_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_authors_name` (`name`),
  KEY `ix_authors_favourite` (`favourite_book_id`),
  CONSTRAINT `fk_authors_favourite` FOREIGN KEY (`favourite_book_id`) REFERENCES `books` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `books` (
  `id` int NOT NULL AUTO_INCREMENT,
  `author_id` int NOT NULL,
  `title` varchar(200) NOT NULL,
  `subtitle` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `slug` varchar(220) GENERATED ALWAYS AS (lower(replace(`title`,' ','-'))) STORED,
  `title_length` int GENERATED ALWAYS AS (char_length(`title`)) VIRTUAL,
  `price` decimal(18,6) NOT NULL DEFAULT '0.000000',
  `weight_grams` double DEFAULT NULL,
  `rating` float DEFAULT NULL,
  `pages` smallint unsigned DEFAULT NULL,
  `huge` bigint DEFAULT NULL,
  `huge_unsigned` bigint unsigned DEFAULT NULL,
  `in_print` tinyint(1) NOT NULL DEFAULT '1',
  `flags` bit(8) DEFAULT NULL,
  `format` enum('paperback','hardcover','ebook') NOT NULL DEFAULT 'paperback',
  `tags` set('new','sale','signed') DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `cover` blob,
  `checksum` varbinary(32) DEFAULT NULL,
  `summary` text,
  `published_on` date DEFAULT NULL,
  `published_at` datetime(3) DEFAULT NULL,
  `touched_at` timestamp NULL DEFAULT NULL,
  `reading_time` time DEFAULT NULL,
  `edition_year` year DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_books_author` (`author_id`),
  KEY `ix_books_composite` (`author_id`,`published_on` DESC),
  UNIQUE KEY `uq_books_slug` (`slug`),
  CONSTRAINT `fk_books_author` FOREIGN KEY (`author_id`) REFERENCES `authors` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ck_books_price` CHECK ((`price` > -1000000))
) ENGINE=InnoDB AUTO_INCREMENT=5000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='books table';

CREATE TABLE `audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `entity` varchar(50) NOT NULL,
  `note` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO `authors` (`id`, `name`, `nickname`, `favourite_book_id`) VALUES
  (1, 'Ada Lovelace', NULL, NULL),
  (2, 'Ünicode Ømega 😀', '', NULL),
  (7, 'Quote''s and \\backslash\\', 'tab\there', NULL);

INSERT INTO `books`
  (`id`, `author_id`, `title`, `subtitle`, `price`, `weight_grams`, `rating`, `pages`, `huge`,
   `huge_unsigned`, `in_print`, `flags`, `format`, `tags`, `metadata`, `cover`, `checksum`,
   `summary`, `published_on`, `published_at`, `touched_at`, `reading_time`, `edition_year`)
VALUES
  (1, 1, 'Notes on the Analytical Engine', 'a subtitle', 12.345678, 501.25, 4.5, 320,
   9223372036854775807, 18446744073709551615, 1, b'10101010', 'hardcover', 'new,signed',
   '{"isbn": "1234567890", "topics": ["math", "engines"]}',
   0x00010203FF00, 0xDEADBEEF, 'Line one\nLine two\rCarriage\tTab\ZCtrlZ',
   '2020-02-29', '2020-02-29 12:34:56.789', '2021-06-01 08:00:00', '-838:59:59', 1999),
  (2, 1, 'Empty & Null Showcase', NULL, -0.000001, NULL, NULL, NULL, -9223372036854775808,
   0, 0, b'00000000', 'ebook', '', '[]', '', 0x00, '', '1000-01-01', '1000-01-01 00:00:00.000',
   NULL, '00:00:00', 1901),
  (4999, 2, 'Emoji 😀 title with ''quotes'' and "double"', NULL, 99999999999.999999, 1e300, 3.4e38,
   65535, 1, 1, 1, b'11111111', 'paperback', 'sale', '{"nested": {"a": [1, 2, {"b": null}]}}',
   0x1A0D0A5C27, NULL, 'utf8mb4 ✓ 中文 🎉', '9999-12-31', '9999-12-31 23:59:59.999',
   '2038-01-18 03:14:07', '838:59:59', 2155);

UPDATE `authors` SET `favourite_book_id` = 1 WHERE `id` = 1;

CREATE OR REPLACE VIEW `v_books` AS
  SELECT `b`.`id` AS `id`, `b`.`title` AS `title`, `a`.`name` AS `author`
  FROM (`books` `b` JOIN `authors` `a` ON (`b`.`author_id` = `a`.`id`));

CREATE OR REPLACE VIEW `v_books_in_print` AS
  SELECT `v_books`.`id` AS `id`, `v_books`.`title` AS `title`
  FROM `v_books`
  WHERE `v_books`.`id` > 0;

DELIMITER ;;

CREATE TRIGGER `trg_books_after_insert` AFTER INSERT ON `books` FOR EACH ROW
BEGIN
  INSERT INTO `audit_log` (`entity`, `note`) VALUES ('books', 'inserted');
  INSERT INTO `audit_log` (`entity`, `note`) VALUES ('books', CONCAT('id=', NEW.`id`));
END ;;

CREATE PROCEDURE `sp_recount`(IN `p_entity` VARCHAR(50), OUT `p_count` INT)
BEGIN
  DECLARE `v_tmp` INT DEFAULT 0;
  SELECT COUNT(*) INTO `v_tmp` FROM `audit_log` WHERE `entity` = `p_entity`;
  SET `p_count` = `v_tmp`;
  INSERT INTO `audit_log` (`entity`, `note`) VALUES (`p_entity`, 'recounted; done');
END ;;

CREATE FUNCTION `fn_title_length`(`p_id` INT) RETURNS INT
  DETERMINISTIC
  READS SQL DATA
BEGIN
  DECLARE `v_len` INT;
  SELECT CHAR_LENGTH(`title`) INTO `v_len` FROM `books` WHERE `id` = `p_id`;
  RETURN IFNULL(`v_len`, 0);
END ;;

CREATE EVENT `ev_cleanup`
  ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00'
  ON COMPLETION PRESERVE
  DISABLE
  DO
BEGIN
  DELETE FROM `audit_log` WHERE `id` < 0;
  DELETE FROM `audit_log` WHERE `entity` = 'never';
END ;;

DELIMITER ;
