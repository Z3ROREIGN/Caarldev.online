module.exports = (req, res) => {
  const v = process.env.INBOX_SECRET || "";
  const s = new URL(req.url, "http://x").searchParams.get("s") || "";
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    tamanhoNoSite: v.length,
    tamanhoTestado: s.length,
    igual: v === s,
    igualSemMaiusculas: v.toLowerCase() === s.toLowerCase(),
  });
};
