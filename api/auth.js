module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  try {
    const { pin } = req.body;
    const serverPin = process.env.DASHBOARD_PIN;

    if (!serverPin) {
      console.error("❌ ERROR: DASHBOARD_PIN not found in environment variables.");
      return res.status(500).json({ success: false, message: 'System Configuration Error' });
    }

    if (pin === serverPin) {
      return res.status(200).json({ success: true, token: "authorized_session" });
    } else {
      return res.status(401).json({ success: false, message: 'Invalid PIN' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};
