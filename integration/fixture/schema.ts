import type { SourceCapabilities } from '../../src/version/types.js';

/**
 * The round-trip fixture's schema, as one statement per array element.
 *
 * Statements are kept separate rather than as one script on purpose: the
 * fixture is created with `execStatements`, which sends each element as-is
 * and never touches this package's own statement parser. A splitting bug
 * therefore cannot corrupt the fixture and hide itself — the fixture is
 * built by something independent of the code under test.
 *
 * That is also why nothing here uses `DELIMITER`: it is a *client* command,
 * and each stored program is already exactly one statement.
 *
 * Version-dependent features are gated on introspected capabilities rather
 * than on a version number, so the same fixture builds on MySQL 5.7, 8.0 and
 * 8.4 while still exercising everything each server actually supports.
 */
export function buildSchemaStatements(capabilities: SourceCapabilities): string[] {
  const statements: string[] = [];

  // Foreign key checks are off only while the two mutually-referencing
  // tables are created; the circular pair is the whole point of this fixture.
  statements.push('SET FOREIGN_KEY_CHECKS = 0');

  statements.push(`CREATE TABLE \`authors\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(120) NOT NULL,
  \`nickname\` varchar(120) DEFAULT NULL,
  \`favourite_book_id\` int DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_authors_name\` (\`name\`),
  KEY \`ix_authors_favourite\` (\`favourite_book_id\`),
  CONSTRAINT \`fk_authors_favourite\` FOREIGN KEY (\`favourite_book_id\`) REFERENCES \`books\` (\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const generatedColumns = capabilities.supportsGeneratedColumns
    ? `  \`slug\` varchar(220) GENERATED ALWAYS AS (lower(replace(\`title\`,' ','-'))) STORED,
  \`title_length\` int GENERATED ALWAYS AS (char_length(\`title\`)) VIRTUAL,
`
    : '';
  const slugIndex = capabilities.supportsGeneratedColumns
    ? '  UNIQUE KEY `uq_books_slug` (`slug`),\n'
    : '';
  const compositeIndex = capabilities.supportsDescendingIndexes
    ? '  KEY `ix_books_composite` (`author_id`,`published_on` DESC),\n'
    : '  KEY `ix_books_composite` (`author_id`,`published_on`),\n';
  const checkConstraint = capabilities.supportsCheckConstraints
    ? ',\n  CONSTRAINT `ck_books_price` CHECK ((`price` > -1000000))'
    : '';
  const jsonColumn = capabilities.supportsJsonType
    ? '  `metadata` json DEFAULT NULL,\n'
    : '  `metadata` longtext DEFAULT NULL,\n';

  statements.push(`CREATE TABLE \`books\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`author_id\` int NOT NULL,
  \`title\` varchar(200) NOT NULL,
  \`subtitle\` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
${generatedColumns}  \`price\` decimal(30,10) NOT NULL DEFAULT '0.0000000000',
  \`weight_grams\` double DEFAULT NULL,
  \`rating\` float DEFAULT NULL,
  \`pages\` smallint unsigned DEFAULT NULL,
  \`huge\` bigint DEFAULT NULL,
  \`huge_unsigned\` bigint unsigned DEFAULT NULL,
  \`in_print\` tinyint(1) NOT NULL DEFAULT '1',
  \`flags\` bit(11) DEFAULT NULL,
  \`format\` enum('paperback','hardcover','ebook') NOT NULL DEFAULT 'paperback',
  \`tags\` set('new','sale','signed') DEFAULT NULL,
${jsonColumn}  \`cover\` blob,
  \`checksum\` varbinary(64) DEFAULT NULL,
  \`fixed_bin\` binary(4) DEFAULT NULL,
  \`summary\` text,
  \`published_on\` date DEFAULT NULL,
  \`published_at\` datetime(6) DEFAULT NULL,
  \`touched_at\` timestamp NULL DEFAULT NULL,
  \`reading_time\` time(3) DEFAULT NULL,
  \`edition_year\` year DEFAULT NULL,
  PRIMARY KEY (\`id\`),
${slugIndex}  KEY \`ix_books_author\` (\`author_id\`),
${compositeIndex}  CONSTRAINT \`fk_books_author\` FOREIGN KEY (\`author_id\`) REFERENCES \`authors\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE${checkConstraint}
) ENGINE=InnoDB AUTO_INCREMENT=5000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='books; with a semicolon and a '' quote'`);

  // A high AUTO_INCREMENT past 2^53, which a JavaScript number cannot hold
  // exactly. Restoring the *next* generated id correctly is the assertion.
  statements.push(`CREATE TABLE \`big_counter\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`label\` varchar(40) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=9007199254740995 DEFAULT CHARSET=utf8mb4`);

  // Empty, but with a non-default AUTO_INCREMENT: the restored table must
  // resume at the same value rather than at 1.
  statements.push(`CREATE TABLE \`empty_with_autoinc\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`note\` varchar(40) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=4242 DEFAULT CHARSET=utf8mb4`);

  // No primary key at all, so the exporter's `unordered-table-read`
  // diagnostic and its unordered path are actually exercised.
  statements.push(`CREATE TABLE \`no_primary_key\` (
  \`a\` int DEFAULT NULL,
  \`b\` varchar(30) DEFAULT NULL,
  KEY \`ix_nopk_a\` (\`a\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // A nontransactional engine, which must produce the
  // `nontransactional-table-not-snapshot-consistent` warning under
  // consistency 'single-transaction'.
  statements.push(`CREATE TABLE \`myisam_notes\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`note\` varchar(80) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4`);

  statements.push(`CREATE TABLE \`audit_log\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`entity\` varchar(50) NOT NULL,
  \`note\` varchar(200) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // A composite primary key plus a composite foreign key, so multi-column
  // key ordering is covered.
  statements.push(`CREATE TABLE \`book_editions\` (
  \`book_id\` int NOT NULL,
  \`edition\` smallint NOT NULL,
  \`isbn\` char(17) CHARACTER SET ascii COLLATE ascii_general_ci DEFAULT NULL,
  \`printed_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`book_id\`,\`edition\`),
  UNIQUE KEY \`uq_editions_isbn\` (\`isbn\`),
  CONSTRAINT \`fk_editions_book\` FOREIGN KEY (\`book_id\`) REFERENCES \`books\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  statements.push('SET FOREIGN_KEY_CHECKS = 1');
  return statements;
}

/**
 * Views, triggers, routines and the event.
 *
 * Kept separate from the tables so data can be loaded *before* triggers
 * exist — a trigger firing during fixture load would fabricate audit rows
 * the assertions do not expect, which is the same reason `mysqldump` emits
 * triggers after a table's data.
 */
export function buildProgramStatements(capabilities: SourceCapabilities): string[] {
  const statements: string[] = [];

  statements.push(`CREATE VIEW \`v_books\` AS
  SELECT \`b\`.\`id\` AS \`id\`, \`b\`.\`title\` AS \`title\`, \`a\`.\`name\` AS \`author\`
  FROM (\`books\` \`b\` JOIN \`authors\` \`a\` ON (\`b\`.\`author_id\` = \`a\`.\`id\`))`);

  // Depends on `v_books`, and — deliberately — sorts *before* it, so the
  // dump's stub-view mechanism is what makes the restore work rather than
  // alphabetical luck.
  statements.push(`CREATE VIEW \`a_dependent_view\` AS
  SELECT \`v_books\`.\`id\` AS \`id\`, \`v_books\`.\`title\` AS \`title\`
  FROM \`v_books\`
  WHERE \`v_books\`.\`id\` > 0`);

  // A multi-statement trigger: without DELIMITER handling in the restore
  // parser, the `;` after its first INSERT would cut the CREATE in half.
  statements.push(`CREATE TRIGGER \`trg_books_after_insert\` AFTER INSERT ON \`books\` FOR EACH ROW
BEGIN
  INSERT INTO \`audit_log\` (\`entity\`, \`note\`) VALUES ('books', 'inserted; one');
  INSERT INTO \`audit_log\` (\`entity\`, \`note\`) VALUES ('books', CONCAT('id=', NEW.\`id\`));
END`);

  statements.push(`CREATE TRIGGER \`trg_books_before_update\` BEFORE UPDATE ON \`books\` FOR EACH ROW
BEGIN
  IF NEW.\`title\` <> OLD.\`title\` THEN
    SET NEW.\`touched_at\` = '2024-01-01 00:00:00';
  END IF;
END`);

  // Semicolons inside the body *and* inside a string literal in the body.
  statements.push(`CREATE PROCEDURE \`sp_recount\`(IN \`p_entity\` VARCHAR(50), OUT \`p_count\` INT)
BEGIN
  DECLARE \`v_tmp\` INT DEFAULT 0;
  SELECT COUNT(*) INTO \`v_tmp\` FROM \`audit_log\` WHERE \`entity\` = \`p_entity\`;
  SET \`p_count\` = \`v_tmp\`;
  INSERT INTO \`audit_log\` (\`entity\`, \`note\`) VALUES (\`p_entity\`, 'recounted; done -- not a comment');
END`);

  statements.push(`CREATE FUNCTION \`fn_title_length\`(\`p_id\` INT) RETURNS INT
  DETERMINISTIC
  READS SQL DATA
BEGIN
  DECLARE \`v_len\` INT;
  SELECT CHAR_LENGTH(\`title\`) INTO \`v_len\` FROM \`books\` WHERE \`id\` = \`p_id\`;
  RETURN IFNULL(\`v_len\`, 0);
END`);

  if (capabilities.supportsEvents) {
    // DISABLE, so it never actually fires during a test run.
    statements.push(`CREATE EVENT \`ev_cleanup\`
  ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00'
  ON COMPLETION PRESERVE
  DISABLE
  DO
BEGIN
  DELETE FROM \`audit_log\` WHERE \`id\` < 0;
  DELETE FROM \`audit_log\` WHERE \`entity\` = 'never; happens';
END`);
  }

  return statements;
}
