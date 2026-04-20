const fs = require('fs');
let code = fs.readFileSync('src/components/MediaDetailsModal.tsx', 'utf8');

// Fix column layout bug on TV
code = code.replace(
  "layout.isCompact && styles.mainRowCompact, isTv && { flexDirection: 'row' as any }",
  "layout.isCompact && !isTv && styles.mainRowCompact"
);

// Fix TS style array falsy bugs
code = code.replace(
  "selectedSeason === season.seasonNumber && styles.seasonTabActive",
  "selectedSeason === season.seasonNumber ? styles.seasonTabActive : undefined"
);
code = code.replace(
  "selectedSeason === season.seasonNumber && styles.seasonTabTextActive",
  "selectedSeason === season.seasonNumber ? styles.seasonTabTextActive : undefined"
);
code = code.replace(
  "isStarted && { opacity: 0.5 }",
  "isStarted ? { opacity: 0.5 } : undefined"
);
code = code.replace(
  "isStarted && { color: '#E50914' }",
  "isStarted ? { color: '#E50914' } : undefined"
);
code = code.replace(
  "const isStarted = currentPos && currentPos > 10;",
  "const isStarted = Boolean(currentPos && currentPos > 10);"
);

// Fix TS style cast
code = code.replace(
  "style={styles.poster}",
  "style={styles.poster as any}"
);

// Fix button wrapper margins
code = code.replace(
  "playBtn: {\n    backgroundColor: '#E50914',\n    paddingHorizontal: 36,\n    paddingVertical: 16,\n    borderRadius: 8,\n    marginRight: 16,\n  },",
  "playBtn: {\n    backgroundColor: '#E50914',\n    paddingHorizontal: 36,\n    paddingVertical: 16,\n    borderRadius: 8,\n  },"
);

code = code.replace(
  "onClick={() => onPlay(primaryActionMedia)}\n                    style={{\n                      cursor: 'pointer',\n                      borderRadius: 8,\n                      outline: 'none',\n                    }}",
  "onClick={() => onPlay(primaryActionMedia)}\n                    style={{\n                      cursor: 'pointer',\n                      borderRadius: 8,\n                      outline: 'none',\n                      display: 'flex',\n                      marginRight: 16,\n                    }}"
);

code = code.replace(
  "trailerBtn: {\n    backgroundColor: 'rgba(255,255,255,0.1)',\n    paddingHorizontal: 24,\n    paddingVertical: 16,\n    borderRadius: 25,\n    marginRight: 12,\n  },",
  "trailerBtn: {\n    backgroundColor: 'rgba(255,255,255,0.1)',\n    paddingHorizontal: 24,\n    paddingVertical: 16,\n    borderRadius: 25,\n  },"
);

code = code.replace(
  "onClick={() => {\n                      setTrailerStatus('loading');\n                      setTrailerErrorTitle('Trailer indisponível no player');\n                      setTrailerErrorMessage('');\n                      setIsTrailerModalOpen(true);\n                    }}\n                    style={{\n                      cursor: 'pointer',\n                      borderRadius: 25,\n                      outline: 'none',\n                    }}",
  "onClick={() => {\n                      setTrailerStatus('loading');\n                      setTrailerErrorTitle('Trailer indisponível no player');\n                      setTrailerErrorMessage('');\n                      setIsTrailerModalOpen(true);\n                    }}\n                    style={{\n                      cursor: 'pointer',\n                      borderRadius: 25,\n                      outline: 'none',\n                      display: 'flex',\n                      marginRight: 12,\n                    }}"
);

code = code.replace(
  "favoriteBtn: {\n    minHeight: 50,\n    paddingHorizontal: 18,\n    borderRadius: 25,\n    borderWidth: 1,\n    borderColor: 'rgba(255,255,255,0.2)',\n    justifyContent: 'center',\n    alignItems: 'center',\n    marginRight: 12,\n    backgroundColor: 'rgba(255,255,255,0.04)',\n  },",
  "favoriteBtn: {\n    minHeight: 50,\n    paddingHorizontal: 18,\n    borderRadius: 25,\n    borderWidth: 1,\n    borderColor: 'rgba(255,255,255,0.2)',\n    justifyContent: 'center',\n    alignItems: 'center',\n    backgroundColor: 'rgba(255,255,255,0.04)',\n  },"
);

code = code.replace(
  "onClick={() => toggleFavorite(favoriteKey)}\n                  style={{\n                    cursor: 'pointer',\n                    borderRadius: 25,\n                    outline: 'none',\n                  }}",
  "onClick={() => toggleFavorite(favoriteKey)}\n                  style={{\n                    cursor: 'pointer',\n                    borderRadius: 25,\n                    outline: 'none',\n                    display: 'flex',\n                    marginRight: 12,\n                  }}"
);

code = code.replace(
  "circleBtn: {\n    width: 50,\n    height: 50,\n    borderRadius: 25,\n    borderWidth: 1,\n    borderColor: 'rgba(255,255,255,0.2)',\n    justifyContent: 'center',\n    alignItems: 'center',\n    marginRight: 12,\n  },",
  "circleBtn: {\n    width: 50,\n    height: 50,\n    borderRadius: 25,\n    borderWidth: 1,\n    borderColor: 'rgba(255,255,255,0.2)',\n    justifyContent: 'center',\n    alignItems: 'center',\n  },"
);

code = code.replace(
  "onClick={() => {}}\n                  style={{\n                    cursor: 'pointer',\n                    borderRadius: 25,\n                    outline: 'none',\n                  }}",
  "onClick={() => {}}\n                  style={{\n                    cursor: 'pointer',\n                    borderRadius: 25,\n                    outline: 'none',\n                    display: 'flex',\n                    marginRight: 12,\n                  }}"
);

fs.writeFileSync('src/components/MediaDetailsModal.tsx', code);
code = code.replace(/ref=\{\(el\) => el && registerNode\(/g, "ref={(el) => { if (el) registerNode(");

code = code.replace(/disableAutoScroll: true,\n\s*\}\)\}/g, "disableAutoScroll: true,\n                    }); } }");
code = code.replace(/onEnter: \(\) => \{\},\n\s*disableAutoScroll: true,\n\s*\}\)\}/g, "onEnter: () => {},\n                      disableAutoScroll: true,\n                    }); } }");
code = code.replace(/onEnter: onClose,\n\s*disableAutoScroll: true,\n\s*\}\)\}/g, "onEnter: onClose,\n              disableAutoScroll: true,\n            }); } }");

fs.writeFileSync('src/components/MediaDetailsModal.tsx', code);
