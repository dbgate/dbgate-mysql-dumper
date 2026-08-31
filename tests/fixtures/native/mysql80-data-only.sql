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
-- Dumping data for table `audit_log`
--

LOCK TABLES `audit_log` WRITE;
/*!40000 ALTER TABLE `audit_log` DISABLE KEYS */;
/*!40000 ALTER TABLE `audit_log` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping data for table `authors`
--

LOCK TABLES `authors` WRITE;
/*!40000 ALTER TABLE `authors` DISABLE KEYS */;
INSERT INTO `authors` VALUES (1,'Ada Lovelace',NULL,1,'2026-08-28 11:05:39'),(2,'Ünicode Ømega 😀','',NULL,'2026-08-28 11:05:39'),(7,'Quote\'s and \\backslash\\','tab	here',NULL,'2026-08-28 11:05:39');
/*!40000 ALTER TABLE `authors` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping data for table `books`
--

LOCK TABLES `books` WRITE;
/*!40000 ALTER TABLE `books` DISABLE KEYS */;
INSERT INTO `books` (`id`, `author_id`, `title`, `subtitle`, `price`, `weight_grams`, `rating`, `pages`, `huge`, `huge_unsigned`, `in_print`, `flags`, `format`, `tags`, `metadata`, `cover`, `checksum`, `summary`, `published_on`, `published_at`, `touched_at`, `reading_time`, `edition_year`) VALUES (1,1,'Notes on the Analytical Engine','a subtitle',12.345678,501.25,4.5,320,9223372036854775807,18446744073709551615,1,0xAA,'hardcover','new,signed','{\"isbn\": \"1234567890\", \"topics\": [\"math\", \"engines\"]}',0x00010203FF00,0xDEADBEEF,'Line one\nLine two\rCarriage	Tab\ZCtrlZ','2020-02-29','2020-02-29 12:34:56.789','2021-06-01 08:00:00','-838:59:59',1999),(2,1,'Empty & Null Showcase',NULL,-0.000001,NULL,NULL,NULL,-9223372036854775808,0,0,0x00,'ebook','','[]','',0x00,'','1000-01-01','1000-01-01 00:00:00.000',NULL,'00:00:00',1901),(4999,2,'Emoji 😀 title with \'quotes\' and \"double\"',NULL,99999999999.999999,1e300,3.4e38,65535,1,1,1,0xFF,'paperback','sale','{\"nested\": {\"a\": [1, 2, {\"b\": null}]}}',0x1A0D0A5C27,NULL,'utf8mb4 ✓ 中文 🎉','9999-12-31','9999-12-31 23:59:59.999','2038-01-18 03:14:07','838:59:59',2155);
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
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on <sanitized>
