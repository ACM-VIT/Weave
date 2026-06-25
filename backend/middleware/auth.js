const supabase = require("../config/supabase");

/**
 * Authentication middleware that verifies the Supabase JWT token.
 * Attaches the authenticated user object to the request.
 */
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header. Expected Bearer token." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Unauthorized access: invalid session token." });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("❌ Authentication error:", err.message);
    return res.status(500).json({ error: "Internal server error during authentication." });
  }
};

module.exports = {
  requireAuth
};
