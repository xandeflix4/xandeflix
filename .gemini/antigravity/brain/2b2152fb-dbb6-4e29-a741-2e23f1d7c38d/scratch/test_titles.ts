
import { cleanMediaTitle, extractSeriesInfo } from './src/lib/titleCleaner';

const titles = [
  "A Bíblia (2013) S01 E01",
  "A Bíblia (2013) S01 E02",
  "Absentia S01E01",
  "Absentia S01E02",
  "9-1-1 S01E01",
  "Os Simpsons - T01 E01",
];

console.log("--- TESTE DE LIMPEZA E AGRUPAMENTO ---");
titles.forEach(t => {
  const result = cleanMediaTitle(t);
  const info = extractSeriesInfo(t);
  console.log(`Original: "${t}"`);
  console.log(`Clean: "${result.cleanTitle}" | Season: ${result.season} | Episode: ${result.episode} | isSeries: ${result.isSeries}`);
  console.log('---');
});
