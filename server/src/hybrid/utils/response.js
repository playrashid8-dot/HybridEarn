export const sendSuccess = (res, msg, data = {}) =>
  res.json({ success: true, msg, data });

export const sendError = (res, code, msg, data = {}) => {
  if (code >= 500) {
    console.error("API ERROR:", msg);
  }

  return res.status(code).json({
    success: false,
    msg: code >= 500 ? "Internal server error" : msg,
    data: data == null ? {} : data,
  });
};
