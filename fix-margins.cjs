const fs = require('fs');
let code = fs.readFileSync('src/components/MediaDetailsModal.tsx', 'utf8');

code = code.replace(
  "                      cursor: 'pointer',\r\n                      borderRadius: 8,\r\n                      outline: 'none',\r\n                    }}",
  "                      cursor: 'pointer',\r\n                      borderRadius: 8,\r\n                      outline: 'none',\r\n                      display: 'flex',\r\n                      marginRight: 16,\r\n                    }}"
);

code = code.replace(
  "                      cursor: 'pointer',\r\n                      borderRadius: 25,\r\n                      outline: 'none',\r\n                    }}",
  "                      cursor: 'pointer',\r\n                      borderRadius: 25,\r\n                      outline: 'none',\r\n                      display: 'flex',\r\n                      marginRight: 12,\r\n                    }}"
);

code = code.replace(
  "                    cursor: 'pointer',\r\n                    borderRadius: 25,\r\n                    outline: 'none',\r\n                  }}",
  "                    cursor: 'pointer',\r\n                    borderRadius: 25,\r\n                    outline: 'none',\r\n                    display: 'flex',\r\n                    marginRight: 12,\r\n                  }}"
);

// We need to replace it twice because both favoriteBtn and shareBtn use it!
code = code.replace(
  "                    cursor: 'pointer',\r\n                    borderRadius: 25,\r\n                    outline: 'none',\r\n                  }}",
  "                    cursor: 'pointer',\r\n                    borderRadius: 25,\r\n                    outline: 'none',\r\n                    display: 'flex',\r\n                    marginRight: 12,\r\n                  }}"
);

code = code.replace(
  "  playBtn: {\r\n    backgroundColor: '#E50914',\r\n    paddingHorizontal: 36,\r\n    paddingVertical: 16,\r\n    borderRadius: 8,\r\n    marginRight: 16,\r\n  },",
  "  playBtn: {\r\n    backgroundColor: '#E50914',\r\n    paddingHorizontal: 36,\r\n    paddingVertical: 16,\r\n    borderRadius: 8,\r\n  },"
);

code = code.replace(
  "  circleBtn: {\r\n    width: 50,\r\n    height: 50,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n    marginRight: 12,\r\n  },",
  "  circleBtn: {\r\n    width: 50,\r\n    height: 50,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n  },"
);

code = code.replace(
  "  favoriteBtn: {\r\n    minHeight: 50,\r\n    paddingHorizontal: 18,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n    marginRight: 12,\r\n    backgroundColor: 'rgba(255,255,255,0.04)',\r\n  },",
  "  favoriteBtn: {\r\n    minHeight: 50,\r\n    paddingHorizontal: 18,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n    backgroundColor: 'rgba(255,255,255,0.04)',\r\n  },"
);

code = code.replace(
  "  trailerBtn: {\r\n    minHeight: 50,\r\n    paddingHorizontal: 18,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n    marginRight: 12,\r\n    backgroundColor: 'rgba(255,255,255,0.04)',\r\n  },",
  "  trailerBtn: {\r\n    minHeight: 50,\r\n    paddingHorizontal: 18,\r\n    borderRadius: 25,\r\n    borderWidth: 1,\r\n    borderColor: 'rgba(255,255,255,0.2)',\r\n    justifyContent: 'center',\r\n    alignItems: 'center',\r\n    backgroundColor: 'rgba(255,255,255,0.04)',\r\n  },"
);

fs.writeFileSync('src/components/MediaDetailsModal.tsx', code);
