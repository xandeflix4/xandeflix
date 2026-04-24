import os

file_path = r'c:\Users\Alexandre-Janaina\Documents\xandeflix-main\src\components\MediaDetailsModal.tsx'

with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Replace backdrop logic
old_backdrop_block = """    // 2. Se não houver backdrop do TMDB
    if (!finalBackdrop) {
      // REGRA:
      if (media.backdrop && media.backdrop !== media.thumbnail) {
        finalBackdrop = media.backdrop;
      } else {
        // Fallback:
        finalBackdrop = fallbackBg;
      }
    }"""

new_backdrop_block = """    // 2. Se não houver backdrop do TMDB ou se estiver carregando, tenta usar o da mídia
    if (!finalBackdrop) {
      if (media.backdrop && media.backdrop !== media.thumbnail) {
        finalBackdrop = media.backdrop;
      } else {
        finalBackdrop = media.backdrop || fallbackBg;
      }
    }"""

# Using a simpler match if the above fails
if old_backdrop_block not in content:
    print("Exact match failed, trying fuzzy match...")
    import re
    content = re.sub(r'if \(!finalBackdrop\) \{.*?\}', new_backdrop_block, content, flags=re.DOTALL)
else:
    content = content.replace(old_backdrop_block, new_backdrop_block)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Replacement done.")
