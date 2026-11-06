module.exports = (req, res) => {
  const v = process.env.INBOX_SECRET;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    definida: typeof v === "string" && v.length > 0,
    tamanho: v ? v.length : 0,
    espacoNasPontas: v ? v !== v.trim() : false,
    caracteresEstranhos: v ? /[^A-Za-z0-9_-]/.test(v) : false,
  });
};
