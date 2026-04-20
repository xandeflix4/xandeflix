const fs = require('fs');
let code = fs.readFileSync('src/components/MediaDetailsModal.tsx', 'utf8');

code = code.replace(/setIsTrailerModalOpen\(true\);\r?\n\s*\},\r?\n\s*\}\)\}/g, "setIsTrailerModalOpen(true);\n                      },\n                    }); } }");

code = code.replace(/currentSeasonNumber: selectedSeason,\r?\n\s*\}\),\r?\n\s*\}\)\}/g, "currentSeasonNumber: selectedSeason,\n                      }),\n                    }); } }");

fs.writeFileSync('src/components/MediaDetailsModal.tsx', code);
