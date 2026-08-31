import type { SourceCapabilities } from '../../src/version/types.js';

/**
 * The round-trip fixture's row data.
 *
 * Every value here exists to pin down one serialization decision, and the
 * comment on each group says which. The whole point is that a dump →
 * restore → compare cycle over this data proves the value path, so nothing
 * is decorative.
 */
export function buildDataStatements(capabilities: SourceCapabilities): string[] {
  const statements: string[] = [];

  statements.push(`INSERT INTO \`authors\` (\`id\`, \`name\`, \`nickname\`, \`favourite_book_id\`, \`created_at\`) VALUES
  (1, 'Ada Lovelace', NULL, NULL, '2021-06-01 08:00:00'),
  (2, 'Ünicode Ømega 😀', '', NULL, '2021-06-01 08:00:01'),
  (7, 'Quote''s and \\\\backslash\\\\', 'tab\\there', NULL, '2021-06-01 08:00:02'),
  (9, 'Ctrl chars \\0 nul \\Z sub \\n lf \\r cr', 'x', NULL, '2021-06-01 08:00:03')`);

  // A gap between 9 and the next generated id is deliberate: AUTO_INCREMENT
  // must resume from the table's stored value, not from max(id)+1.
  statements.push("INSERT INTO `authors` (`name`) VALUES ('Generated Id Author')");

  const metadataColumn = capabilities.supportsJsonType ? '`metadata`' : '`metadata`';
  const jsonValues = [
    // Key order and inner spacing are the server's; a driver that parsed and
    // re-serialized the value would not reproduce them.
    `'{"isbn": "1234567890", "topics": ["math", "engines"], "nested": {"deep": [1, 2, {"b": null}]}}'`,
    `'[]'`,
    `'{"emoji": "😀", "quote": "she said \\\\"hi\\\\"", "backslash": "a\\\\\\\\b"}'`,
    'NULL',
  ];

  statements.push(`INSERT INTO \`books\`
  (\`id\`, \`author_id\`, \`title\`, \`subtitle\`, \`price\`, \`weight_grams\`, \`rating\`, \`pages\`,
   \`huge\`, \`huge_unsigned\`, \`in_print\`, \`flags\`, \`format\`, \`tags\`, ${metadataColumn},
   \`cover\`, \`checksum\`, \`fixed_bin\`, \`summary\`, \`published_on\`, \`published_at\`,
   \`touched_at\`, \`reading_time\`, \`edition_year\`)
VALUES
  -- Extremes: the exact BIGINT bounds, a 30,10 DECIMAL at full precision,
  -- a BLOB containing NUL and 0xFF, and every escape-worthy character.
  (1, 1, 'Notes on the Analytical Engine', 'a subtitle', 12345678901234567890.1234567890,
   501.25, 4.5, 320, 9223372036854775807, 18446744073709551615, 1, b'10101010101',
   'hardcover', 'new,signed', ${jsonValues[0]},
   0x00010203FF00, 0xDEADBEEF, 0x00FF00FF,
   'Line one\\nLine two\\rCarriage\\tTab\\ZCtrlZ NUL:\\0 quote:'' dquote:" backslash:\\\\',
   '2020-02-29', '2020-02-29 12:34:56.789012', '2021-06-01 08:00:00', '-838:59:59.000', 1999),
  -- Emptiness and the negative bound: empty string, empty blob, zero,
  -- BIGINT minimum, empty SET.
  (2, 1, 'Empty & Null Showcase', NULL, -0.0000000001, NULL, NULL, NULL,
   -9223372036854775808, 0, 0, b'00000000000', 'ebook', '', ${jsonValues[1]},
   '', 0x00, 0x00000000, '', '1000-01-01', '1000-01-01 00:00:00.000000',
   NULL, '00:00:00.000', 1901),
  -- Unicode beyond the BMP, the largest DATE/DATETIME/TIME, and the
  -- TIMESTAMP upper bound.
  (4999, 2, 'Emoji 😀 title with ''quotes'' and "double" and 中文', NULL, 99999999999999999999.9999999999,
   1.7976931348623157e308, 3.4028234e38, 65535, 1, 1, 1, b'11111111111',
   'paperback', 'sale', ${jsonValues[2]},
   0x1A0D0A5C27, NULL, NULL, 'utf8mb4 ✓ 中文 🎉 zero-width:\\u200b', '9999-12-31',
   '9999-12-31 23:59:59.999999', '2038-01-18 03:14:07', '838:59:59.000', 2155),
  -- All-NULL row, so every nullable column's NULL path is covered.
  (5001, 7, 'All Nulls', NULL, 0, NULL, NULL, NULL, NULL, NULL, 1, NULL,
   'paperback', NULL, ${jsonValues[3]}, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL)`);

  statements.push(`INSERT INTO \`book_editions\` (\`book_id\`, \`edition\`, \`isbn\`, \`printed_at\`) VALUES
  (1, 1, '978-0-000-00000-1', '2020-03-01 10:00:00'),
  (1, 2, '978-0-000-00000-2', '2021-03-01 10:00:00'),
  (2, 1, NULL, NULL),
  (4999, 1, '978-0-000-04999-1', '2022-03-01 10:00:00')`);

  statements.push(`INSERT INTO \`big_counter\` (\`id\`, \`label\`) VALUES
  (9007199254740993, 'past 2^53'),
  (9007199254740994, 'past 2^53 + 1')`);

  statements.push(`INSERT INTO \`no_primary_key\` (\`a\`, \`b\`) VALUES
  (1, 'one'), (2, 'two'), (NULL, NULL), (2, 'two again')`);

  statements.push(`INSERT INTO \`myisam_notes\` (\`note\`) VALUES ('myisam one'), ('myisam two')`);

  statements.push(`INSERT INTO \`audit_log\` (\`entity\`, \`note\`) VALUES
  ('seed', 'pre-existing row; with semicolon'),
  ('seed', NULL)`);

  // Closes the circular foreign key: authors -> books -> authors.
  statements.push('UPDATE `authors` SET `favourite_book_id` = 1 WHERE `id` = 1');
  statements.push('UPDATE `authors` SET `favourite_book_id` = 4999 WHERE `id` = 2');

  return statements;
}
