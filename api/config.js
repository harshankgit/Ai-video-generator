// Tells the browser which optional server features are enabled.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const env = process.env;
  res.status(200).json({
    gemini: Boolean(env.GEMINI_API_KEY),
    images: Boolean((env.CF_ACCOUNT_ID && env.CF_API_TOKEN) || env.POLLINATIONS_KEY),
    server: true,
  });
}
