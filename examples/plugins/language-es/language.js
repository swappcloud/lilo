// A translation-only plugin needs no tools, permissions or native code.
function describe() {
  return { tools: [], commands: [], ui: {
    localized: { es: {
      "Translation coverage": "Cobertura de traducción",
      "Partial example; missing phrases use English.": "Ejemplo parcial; las frases que faltan se muestran en inglés."
    } },
    status: [{ label: "Translation coverage", value: "Partial example; missing phrases use English." }]
  } };
}
