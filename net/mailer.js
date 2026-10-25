/* mailer.js — 极简 SMTP 发送（隐式 TLS，QQ 邮箱 465）
 * 不引入任何第三方依赖：只用 Node 内置 net/tls。
 * 用法：await smtpSend({ host, port, user, pass, to, subject, text })
 */
"use strict";

const tls = require("tls");

function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }

/* 从响应流里切出一条完整 SMTP 响应（支持多行 250-xxx） */
function takeResponse(buf) {
  const lines = buf.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d{3}) /.exec(lines[i]);
    if (m) {
      const code = Number(m[1]);
      const text = lines.slice(0, i + 1).join("\n");
      const rest = lines.slice(i + 1).join("\r\n");
      return { code, text, rest };
    }
  }
  return null;
}

function smtpSend(o) {
  const host = o.host || "smtp.qq.com";
  const port = o.port || 465;
  const timeout = o.timeout || 25000;

  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    let idx = 0;

    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    sock.setEncoding("utf8");
    sock.setTimeout(timeout);
    sock.on("timeout", () => finish(new Error("SMTP 超时")));
    sock.on("error", (e) => finish(e));

    const msg = [
      "From: " + o.fromName + " <" + o.user + ">",
      "To: <" + o.to + ">",
      "Subject: " + o.subject,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "Date: " + new Date().toUTCString(),
      "",
      Buffer.from(o.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
      "."
    ].join("\r\n");

    /* [期望响应码, 要发送的内容] —— 第一项是连接后的欢迎横幅，不发送 */
    const steps = [
      [220, null],
      [250, "EHLO azi-relay\r\n"],
      [334, "AUTH LOGIN\r\n"],
      [334, b64(o.user) + "\r\n"],
      [235, b64(o.pass) + "\r\n"],
      [250, "MAIL FROM:<" + o.user + ">\r\n"],
      [250, "RCPT TO:<" + o.to + ">\r\n"],
      [354, "DATA\r\n"],
      [250, msg + "\r\n"],
      [221, "QUIT\r\n"]
    ];

    function finish(err) {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { }
      err ? reject(err) : resolve(true);
    }

    function pump() {
      const r = takeResponse(buf);
      if (!r) return;
      buf = r.rest;

      const step = steps[idx];
      if (!step) return finish(null);
      if (r.code !== step[0]) {
        return finish(new Error("SMTP 第 " + idx + " 步期望 " + step[0] + "，实际 " + r.code + "：" + r.text.slice(0, 160)));
      }
      if (r.code === 221) return finish(null);
      idx++;
      const next = steps[idx];
      if (next && next[1] !== null) sock.write(next[1]);
      pump();
    }

    sock.on("data", (d) => { buf += d; pump(); });
    sock.on("connect", () => { /* 等服务端横幅 */ });
  });
}

module.exports = { smtpSend };
