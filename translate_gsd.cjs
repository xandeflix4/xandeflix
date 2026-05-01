const fs = require('fs');
const path = require('path');
const https = require('https');

const SKILLS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Alexandre-Janaina', '.gemini', 'antigravity', 'skills');

async function translateText(text) {
  return new Promise((resolve, reject) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          let translated = '';
          if (parsed && parsed[0]) {
            parsed[0].forEach(item => {
              if (item[0]) translated += item[0];
            });
          }
          resolve(translated.trim());
        } catch (e) {
          resolve(text); // Fallback to original
        }
      });
    }).on('error', (e) => {
      resolve(text); // Fallback to original
    });
  });
}

async function run() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`Diretório de skills não encontrado: ${SKILLS_DIR}`);
    return;
  }

  const items = fs.readdirSync(SKILLS_DIR);
  let count = 0;

  for (const item of items) {
    if (item.startsWith('gsd-')) {
      const skillPath = path.join(SKILLS_DIR, item, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf8');
        
        // Match only description: in the YAML frontmatter
        // Assuming frontmatter is at the top between ---
        const descRegex = /^description:\s*(.+)$/m;
        const match = content.match(descRegex);
        
        if (match && match[1]) {
          const originalText = match[1].trim();
          
          // Se já parece estar em português (algumas palavras chave), pular
          if (originalText.toLowerCase().includes('gerenciar') || originalText.toLowerCase().includes('criar') || originalText.toLowerCase().includes('atualizar')) {
            console.log(`[PULADO] ${item}: Já parece estar em PT-BR`);
            continue;
          }

          const translated = await translateText(originalText);
          
          if (translated && translated !== originalText) {
            const newContent = content.replace(descRegex, `description: ${translated}`);
            fs.writeFileSync(skillPath, newContent, 'utf8');
            console.log(`[SUCESSO] ${item}:`);
            console.log(`  EN: ${originalText}`);
            console.log(`  PT: ${translated}`);
            count++;
          } else {
             console.log(`[FALHA] ${item}: Não traduzido (ou idêntico).`);
          }
        } else {
           console.log(`[AVISO] ${item}: Campo description não encontrado.`);
        }
        
        // Aguarda 150ms para evitar rate limit do Google Translate
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
  
  console.log(`\nTradução concluída! ${count} arquivos atualizados.`);
}

run();
