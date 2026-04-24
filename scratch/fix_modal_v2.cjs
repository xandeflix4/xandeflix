const fs = require('fs');
const path = 'c:\\Users\\Alexandre-Janaina\\Documents\\xandeflix-main\\src\\components\\MediaDetailsModal.tsx';

let content = fs.readFileSync(path, 'utf8');

const correctBlock = `  const displayData = useMemo(() => {
    // 1. Tenta usar o backdrop vindo do TMDB
    let finalBackdrop = tmdbData?.backdrop;

    // 2. Se não houver backdrop do TMDB ou se estiver carregando, tenta usar o da mídia
    if (!finalBackdrop) {
      if (media.backdrop && media.backdrop !== media.thumbnail) {
        finalBackdrop = media.backdrop;
      } else {
        finalBackdrop = media.backdrop || fallbackBg;
      }
    }

    return {
      ...media,
      description: tmdbData?.description || media.description,
      year: tmdbData?.year || media.year,
      rating: tmdbData?.rating || media.rating,
      backdrop: finalBackdrop,
      thumbnail: tmdbData?.thumbnail || media.thumbnail,
    };
  }, [media, tmdbData]);`;

content = content.replace(/const displayData = useMemo\(\(\) => \{[\s\S]*?\}, \[media, tmdbData\]\);/, correctBlock);

fs.writeFileSync(path, content, 'utf8');
console.log('Done');
