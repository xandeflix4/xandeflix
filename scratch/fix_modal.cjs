const fs = require('fs');
const path = 'c:\\Users\\Alexandre-Janaina\\Documents\\xandeflix-main\\src\\components\\MediaDetailsModal.tsx';

let content = fs.readFileSync(path, 'utf8');

const newBackdropBlock = `    // 2. Se não houver backdrop do TMDB ou se estiver carregando, tenta usar o da mídia
    if (!finalBackdrop) {
      if (media.backdrop && media.backdrop !== media.thumbnail) {
        finalBackdrop = media.backdrop;
      } else {
        finalBackdrop = media.backdrop || fallbackBg;
      }
    }`;

content = content.replace(/if \(!finalBackdrop\) \{[\s\S]*?\}/, newBackdropBlock);

fs.writeFileSync(path, content, 'utf8');
console.log('Done');
