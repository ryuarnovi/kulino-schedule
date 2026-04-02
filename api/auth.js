module.exports = async function handler(req, res) {
    const pin = req.body?.pin || req.query.pin;
    const correctPin = process.env.DASHBOARD_PIN;

    if (pin && pin === correctPin) {
        return res.status(200).json({ status: "AUTHORIZED" });
    } else {
        return res.status(401).json({ error: "INVALID_PIN" });
    }
}
