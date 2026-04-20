const fs = require('fs');
let code = fs.readFileSync('src/components/MediaDetailsModal.tsx', 'utf8');

// The string 'disableAutoScroll: true,\r\n          })}'
code = code.replace(/disableAutoScroll: true,\r?\n\s*\}\)\}/g, "disableAutoScroll: true,\r\n            }); } }");

fs.writeFileSync('src/components/MediaDetailsModal.tsx', code);
