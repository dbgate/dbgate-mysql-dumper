-- MySQL dump 10.13  Distrib <sanitized>, for <platform>
--
-- Host: <sanitized>    Database: refdb
-- ------------------------------------------------------
-- Server version	8.0.44

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `audit_log`
--

DROP TABLE IF EXISTS `audit_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `entity` varchar(50) NOT NULL,
  `note` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `audit_log`
--

LOCK TABLES `audit_log` WRITE;
/*!40000 ALTER TABLE `audit_log` DISABLE KEYS */;
/*!40000 ALTER TABLE `audit_log` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `authors`
--

DROP TABLE IF EXISTS `authors`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `authors`
--

LOCK TABLES `authors` WRITE;
/*!40000 ALTER TABLE `authors` DISABLE KEYS */;
INSERT INTO `authors` (`id`, `name`, `nickname`, `favourite_book_id`, `created_at`) VALUES (1,'Ada Lovelace',NULL,1,'2026-08-28 11:05:39');
INSERT INTO `authors` (`id`, `name`, `nickname`, `favourite_book_id`, `created_at`) VALUES (2,'Ünicode Ømega 😀','',NULL,'2026-08-28 11:05:39');
INSERT INTO `authors` (`id`, `name`, `nickname`, `favourite_book_id`, `created_at`) VALUES (7,'Quote\'s and \\backslash\\','tab	here',NULL,'2026-08-28 11:05:39');
/*!40000 ALTER TABLE `authors` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `books`
--

DROP TABLE IF EXISTS `books`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `books` (
  `id` int NOT NULL AUTO_INCREMENT,
  `author_id` int NOT NULL,
  `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `subtitle` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `slug` varchar(220) COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS (lower(replace(`title`,_utf8mb4' ',_utf8mb4'-'))) STORED,
  `title_length` int GENERATED ALWAYS AS (char_length(`title`)) VIRTUAL,
  `price` decimal(18,6) NOT NULL DEFAULT '0.000000',
  `weight_grams` double DEFAULT NULL,
  `rating` float DEFAULT NULL,
  `pages` smallint unsigned DEFAULT NULL,
  `huge` bigint DEFAULT NULL,
  `huge_unsigned` bigint unsigned DEFAULT NULL,
  `in_print` tinyint(1) NOT NULL DEFAULT '1',
  `flags` bit(8) DEFAULT NULL,
  `format` enum('paperback','hardcover','ebook') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'paperback',
  `tags` set('new','sale','signed') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `cover` blob,
  `checksum` varbinary(32) DEFAULT NULL,
  `summary` text COLLATE utf8mb4_unicode_ci,
  `published_on` date DEFAULT NULL,
  `published_at` datetime(3) DEFAULT NULL,
  `touched_at` timestamp NULL DEFAULT NULL,
  `reading_time` time DEFAULT NULL,
  `edition_year` year DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_books_slug` (`slug`),
  KEY `ix_books_author` (`author_id`),
  KEY `ix_books_composite` (`author_id`,`published_on` DESC),
  CONSTRAINT `fk_books_author` FOREIGN KEY (`author_id`) REFERENCES `authors` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ck_books_price` CHECK ((`price` > -(1000000)))
) ENGINE=InnoDB AUTO_INCREMENT=5000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='books table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `books`
--

LOCK TABLES `books` WRITE;
/*!40000 ALTER TABLE `books` DISABLE KEYS */;
INSERT INTO `books` (`id`, `author_id`, `title`, `subtitle`, `price`, `weight_grams`, `rating`, `pages`, `huge`, `huge_unsigned`, `in_print`, `flags`, `format`, `tags`, `metadata`, `cover`, `checksum`, `summary`, `published_on`, `published_at`, `touched_at`, `reading_time`, `edition_year`) VALUES (1,1,'Notes on the Analytical Engine','a subtitle',12.345678,501.25,4.5,320,9223372036854775807,18446744073709551615,1,0xAA,'hardcover','new,signed','{\"isbn\": \"1234567890\", \"topics\": [\"math\", \"engines\"]}',0x00010203FF00,0xDEADBEEF,'Line one\nLine two\rCarriage	Tab\ZCtrlZ','2020-02-29','2020-02-29 12:34:56.789','2021-06-01 08:00:00','-838:59:59',1999);
INSERT INTO `books` (`id`, `author_id`, `title`, `subtitle`, `price`, `weight_grams`, `rating`, `pages`, `huge`, `huge_unsigned`, `in_print`, `flags`, `format`, `tags`, `metadata`, `cover`, `checksum`, `summary`, `published_on`, `published_at`, `touched_at`, `reading_time`, `edition_year`) VALUES (2,1,'Empty & Null Showcase',NULL,-0.000001,NULL,NULL,NULL,-9223372036854775808,0,0,0x00,'ebook','','[]',_binary '',0x00,'','1000-01-01','1000-01-01 00:00:00.000',NULL,'00:00:00',1901);
INSERT INTO `books` (`id`, `author_id`, `title`, `subtitle`, `price`, `weight_grams`, `rating`, `pages`, `huge`, `huge_unsigned`, `in_print`, `flags`, `format`, `tags`, `metadata`, `cover`, `checksum`, `summary`, `published_on`, `published_at`, `touched_at`, `reading_time`, `edition_year`) VALUES (4999,2,'Emoji 😀 title with \'quotes\' and \"double\"',NULL,99999999999.999999,1e300,3.4e38,65535,1,1,1,0xFF,'paperback','sale','{\"nested\": {\"a\": [1, 2, {\"b\": null}]}}',0x1A0D0A5C27,NULL,'utf8mb4 ✓ 中文 🎉','9999-12-31','9999-12-31 23:59:59.999','2038-01-18 03:14:07','838:59:59',2155);
/*!40000 ALTER TABLE `books` ENABLE KEYS */;
UNLOCK TABLES;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_0900_ai_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER `trg_books_after_insert` AFTER INSERT ON `books` FOR EACH ROW BEGIN
  INSERT INTO `audit_log` (`entity`, `note`) VALUES ('books', 'inserted');
  INSERT INTO `audit_log` (`entity`, `note`) VALUES ('books', CONCAT('id=', NEW.`id`));
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Temporary view structure for view `v_books`
--

DROP TABLE IF EXISTS `v_books`;
/*!50001 DROP VIEW IF EXISTS `v_books`*/;
SET @saved_cs_client     = @@character_set_client;
/*!50503 SET character_set_client = utf8mb4 */;
/*!50001 CREATE VIEW `v_books` AS SELECT 
 1 AS `id`,
 1 AS `title`,
 1 AS `author`*/;
SET character_set_client = @saved_cs_client;

--
-- Temporary view structure for view `v_books_in_print`
--

DROP TABLE IF EXISTS `v_books_in_print`;
/*!50001 DROP VIEW IF EXISTS `v_books_in_print`*/;
SET @saved_cs_client     = @@character_set_client;
/*!50503 SET character_set_client = utf8mb4 */;
/*!50001 CREATE VIEW `v_books_in_print` AS SELECT 
 1 AS `id`,
 1 AS `title`*/;
SET character_set_client = @saved_cs_client;

--
-- Dumping events for database 'refdb'
--
/*!50106 SET @save_time_zone= @@TIME_ZONE */ ;
/*!50106 DROP EVENT IF EXISTS `ev_cleanup` */;
DELIMITER ;;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;;
/*!50003 SET character_set_client  = utf8mb4 */ ;;
/*!50003 SET character_set_results = utf8mb4 */ ;;
/*!50003 SET collation_connection  = utf8mb4_0900_ai_ci */ ;;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;;
/*!50003 SET @saved_time_zone      = @@time_zone */ ;;
/*!50003 SET time_zone             = 'SYSTEM' */ ;;
/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`%`*/ /*!50106 EVENT `ev_cleanup` ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' ON COMPLETION PRESERVE DISABLE DO BEGIN
  DELETE FROM `audit_log` WHERE `id` < 0;
  DELETE FROM `audit_log` WHERE `entity` = 'never';
END */ ;;
/*!50003 SET time_zone             = @saved_time_zone */ ;;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;;
/*!50003 SET character_set_client  = @saved_cs_client */ ;;
/*!50003 SET character_set_results = @saved_cs_results */ ;;
/*!50003 SET collation_connection  = @saved_col_connection */ ;;
DELIMITER ;
/*!50106 SET TIME_ZONE= @save_time_zone */ ;

--
-- Dumping routines for database 'refdb'
--
/*!50003 DROP FUNCTION IF EXISTS `fn_title_length` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_0900_ai_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE DEFINER=`root`@`%` FUNCTION `fn_title_length`(`p_id` INT) RETURNS int
    READS SQL DATA
    DETERMINISTIC
BEGIN
  DECLARE `v_len` INT;
  SELECT CHAR_LENGTH(`title`) INTO `v_len` FROM `books` WHERE `id` = `p_id`;
  RETURN IFNULL(`v_len`, 0);
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sp_recount` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_0900_ai_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE DEFINER=`root`@`%` PROCEDURE `sp_recount`(IN `p_entity` VARCHAR(50), OUT `p_count` INT)
BEGIN
  DECLARE `v_tmp` INT DEFAULT 0;
  SELECT COUNT(*) INTO `v_tmp` FROM `audit_log` WHERE `entity` = `p_entity`;
  SET `p_count` = `v_tmp`;
  INSERT INTO `audit_log` (`entity`, `note`) VALUES (`p_entity`, 'recounted; done');
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Final view structure for view `v_books`
--

/*!50001 DROP VIEW IF EXISTS `v_books`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_0900_ai_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */
/*!50001 VIEW `v_books` AS select `b`.`id` AS `id`,`b`.`title` AS `title`,`a`.`name` AS `author` from (`books` `b` join `authors` `a` on((`b`.`author_id` = `a`.`id`))) */;
/*!50001 SET character_set_client      = @saved_cs_client */;
/*!50001 SET character_set_results     = @saved_cs_results */;
/*!50001 SET collation_connection      = @saved_col_connection */;

--
-- Final view structure for view `v_books_in_print`
--

/*!50001 DROP VIEW IF EXISTS `v_books_in_print`*/;
/*!50001 SET @saved_cs_client          = @@character_set_client */;
/*!50001 SET @saved_cs_results         = @@character_set_results */;
/*!50001 SET @saved_col_connection     = @@collation_connection */;
/*!50001 SET character_set_client      = utf8mb4 */;
/*!50001 SET character_set_results     = utf8mb4 */;
/*!50001 SET collation_connection      = utf8mb4_0900_ai_ci */;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */
/*!50001 VIEW `v_books_in_print` AS select `v_books`.`id` AS `id`,`v_books`.`title` AS `title` from `v_books` where (`v_books`.`id` > 0) */;
/*!50001 SET character_set_client      = @saved_cs_client */;
/*!50001 SET character_set_results     = @saved_cs_results */;
/*!50001 SET collation_connection      = @saved_col_connection */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on <sanitized>
