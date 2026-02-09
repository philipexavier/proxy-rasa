function authMiddleware(apiKey) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token !== apiKey) {
      return res.status(401).json({
        error: {
          message: "Unauthorized",
          type: "authentication_error",
        },
      });
    }
    return next();
  };
}

export { authMiddleware };
