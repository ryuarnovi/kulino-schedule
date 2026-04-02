module.exports = async function handler(req, res) {
    // Pastikan PIN terbaca dari body (POST) atau query (GET)
    const pin = (req.body?.pin || req.query?.pin)?.toString().trim();
    const correctPin = process.env.DASHBOARD_PIN?.toString().trim();

    if (pin && pin === correctPin) {
        return res.status(200).json({ status: "AUTHORIZED" });
    } else {
        // Log ini akan muncul di tab "Logs" di Vercel Dashboard Anda
        console.warn(`Auth failed: Received [${pin}], Expected [${correctPin}]`);
        return res.status(401).json({ error: "INVALID_PIN" });
    }
}
