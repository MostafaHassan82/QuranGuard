# Coverage diff - pages vs synthetic

Generated: 2026-05-24T00:01:17.867Z

| Group | Covered | Lines | Line % |
|---|---:|---:|---:|
| pages | 4790 | 5426 | 88.3% |
| synthetic | 5161 | 5426 | 95.1% |

**Overall delta (pages - synthetic): -6.8 percentage points**

| File | pages % | synthetic % | Delta | pages-only | synthetic-only | pages uncovered | synthetic uncovered |
|---|---:|---:|---:|---:|---:|---:|---:|
| js/background.js | 88.3% | 95.8% | -7.5 | 0 | 94 | 146 | 52 |
| js/badge/badge.js | 98.4% | 100% | -1.6 | 0 | 1 | 1 | 0 |
| js/content.js | 84.4% | 93.6% | -9.2 | 4 | 190 | 316 | 130 |
| js/debug-bridge.js | 85.7% | 100% | -14.3 | 0 | 1 | 1 | 0 |
| js/panel/actions.js | 86.7% | 86.7% | 0 | 0 | 0 | 26 | 26 |
| js/panel/keyboard.js | 96.4% | 96.4% | 0 | 0 | 0 | 4 | 4 |
| js/panel/model.js | 78.5% | 95.8% | -17.3 | 0 | 25 | 31 | 6 |
| js/panel/sidebar-surface.js | 91.5% | 99.1% | -7.6 | 0 | 43 | 48 | 5 |
| js/render/fonts.js | 100% | 100% | 0 | 0 | 0 | 0 | 0 |
| js/render/swap.js | 95.9% | 95.9% | 0 | 0 | 0 | 5 | 5 |
| js/shared/i18n.js | 100% | 100% | 0 | 0 | 0 | 0 | 0 |
| js/shared/log.js | 91.9% | 100% | -8.1 | 0 | 5 | 5 | 0 |
| js/shared/messaging.js | 69.2% | 75% | -5.8 | 0 | 3 | 16 | 13 |
| js/storage/persisted.js | 82.8% | 90.8% | -8 | 0 | 7 | 15 | 8 |
| js/storage/prefs.js | 91% | 100% | -9 | 0 | 6 | 6 | 0 |
| js/verifier/classify.js | 87.9% | 87.9% | 0 | 0 | 0 | 7 | 7 |
| js/verifier/indexes.js | 100% | 100% | 0 | 0 | 0 | 0 | 0 |
| js/verifier/normalize.js | 100% | 100% | 0 | 0 | 0 | 0 | 0 |
| js/verifier/orange.js | 85.2% | 85.2% | 0 | 0 | 0 | 9 | 9 |
| js/verifier/references.js | 100% | 100% | 0 | 0 | 0 | 0 | 0 |

## Line Detail

- `js/background.js`
  - synthetic only: 84-90, 94-100, 1014-1018, 1029-1035, 1106-1117, 1121-1123, 1127-1131, 1173-1190, 1209-1210, 1253-1268, 1290-1292, 1296-1304
- `js/badge/badge.js`
  - synthetic only: 15
- `js/content.js`
  - pages only: 521, 536-538
  - synthetic only: 87-88, 105-113, 251-257, 479-483, 487, 646-649, 875-877, 1037-1045, 1099-1101, 1105-1108, 1116-1118, 1151-1154, 1235-1239, 1285-1287, 1331-1337, 1339-1382, 1387-1393, 1397-1407, 1410, 1414-1415, 1417-1418, 1492-1498, 1500-1503, 1523-1536, 1545-1556, 1647, 1872-1882, 1910-1912, 1915-1916
- `js/debug-bridge.js`
  - synthetic only: 6
- `js/panel/model.js`
  - synthetic only: 48-55, 57-73
- `js/panel/sidebar-surface.js`
  - synthetic only: 143-146, 166-191, 206-208, 219-221, 303-308, 412
- `js/shared/log.js`
  - synthetic only: 30-34
- `js/shared/messaging.js`
  - synthetic only: 53-55
- `js/storage/persisted.js`
  - synthetic only: 8-14
- `js/storage/prefs.js`
  - synthetic only: 47-49, 59-61

## Uncovered By Group

- `js/background.js`
  - pages uncovered: 30, 84-90, 94-100, 120-121, 355, 359, 662-664, 873-880, 916-919, 972-973, 1001-1004, 1008-1009, 1014-1018, 1029-1045, 1106-1117, 1121-1131, 1138-1143, 1173-1190, 1209-1210, 1253-1268, 1287-1292, 1296-1304, 1316, 1320
  - synthetic uncovered: 30, 120-121, 355, 359, 662-664, 873-880, 916-919, 972-973, 1001-1004, 1008-1009, 1036-1045, 1124-1126, 1138-1143, 1287-1289, 1316, 1320
- `js/badge/badge.js`
  - pages uncovered: 15
  - synthetic uncovered: none
- `js/content.js`
  - pages uncovered: 87-88, 98-100, 102-103, 105-113, 205, 251-257, 479-487, 533-535, 540-542, 558, 560-567, 646-649, 680, 792-794, 875-877, 974-983, 1037-1045, 1091-1092, 1099-1101, 1105-1108, 1116-1118, 1138-1140, 1151-1154, 1235-1239, 1254, 1256-1257, 1285-1287, 1294-1301, 1331-1337, 1339-1415, 1417-1418, 1466-1471, 1492-1498, 1500-1503, 1523-1539, 1545-1556, 1564-1565, 1584, 1597-1598, 1607, 1647, 1769-1774, 1857-1860, 1864-1870, 1872-1882, 1910-1912, 1915-1916, 1919-1924, 1929-1934, 1982-1983, 2139-2141, 2145, 2147, 2162-2168, 2174-2175
  - synthetic uncovered: 98-100, 102-103, 205, 484-486, 521, 533-538, 540-542, 558, 560-567, 680, 792-794, 974-983, 1091-1092, 1138-1140, 1254, 1256-1257, 1294-1301, 1383-1386, 1394-1396, 1408-1409, 1411-1413, 1466-1471, 1537-1539, 1564-1565, 1584, 1597-1598, 1607, 1769-1774, 1857-1860, 1864-1870, 1919-1924, 1929-1934, 1982-1983, 2139-2141, 2145, 2147, 2162-2168, 2174-2175
- `js/debug-bridge.js`
  - pages uncovered: 6
  - synthetic uncovered: none
- `js/panel/actions.js`
  - pages uncovered: 92-94, 139, 144-154, 165-175
  - synthetic uncovered: 92-94, 139, 144-154, 165-175
- `js/panel/keyboard.js`
  - pages uncovered: 87, 99-101
  - synthetic uncovered: 87, 99-101
- `js/panel/model.js`
  - pages uncovered: 48-55, 57-73, 99-102, 148-149
  - synthetic uncovered: 99-102, 148-149
- `js/panel/sidebar-surface.js`
  - pages uncovered: 143-146, 166-191, 206-208, 219-221, 303-308, 340-344, 412
  - synthetic uncovered: 340-344
- `js/render/swap.js`
  - pages uncovered: 57, 61, 75-77
  - synthetic uncovered: 57, 61, 75-77
- `js/shared/log.js`
  - pages uncovered: 30-34
  - synthetic uncovered: none
- `js/shared/messaging.js`
  - pages uncovered: 9-10, 31-41, 53-55
  - synthetic uncovered: 9-10, 31-41
- `js/storage/persisted.js`
  - pages uncovered: 8-14, 40-47
  - synthetic uncovered: 40-47
- `js/storage/prefs.js`
  - pages uncovered: 47-49, 59-61
  - synthetic uncovered: none
- `js/verifier/classify.js`
  - pages uncovered: 22-23, 31-32, 59-61
  - synthetic uncovered: 22-23, 31-32, 59-61
- `js/verifier/orange.js`
  - pages uncovered: 24-32
  - synthetic uncovered: 24-32
