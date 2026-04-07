// utils/nodemailer.js
const nodemailer = require("nodemailer");

function assertMailConfig() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    const error = new Error("EMAIL_USER or EMAIL_PASS is missing in backend environment");
    error.code = "EMAIL_CONFIG_MISSING";
    throw error;
  }
}

const sendMail = async (email, code) => {
  assertMailConfig();
  // Use a proper transactional email service (RECOMMENDED: Resend, Mailgun, SES, etc.)
  // For now, we'll make Gmail as safe as possible

  const transporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,        // e.g. eram.tech.khi@gmail.com
      pass: process.env.EMAIL_PASS,        // App Password (not regular password!)
    },
  });

  const mailOptions = {
    from: '"ERAM" <no-reply@eram.app>',           // This is what shows
    sender: process.env.EMAIL_USER,               // Actual sending address
    replyTo: "support@eram.app",                  // Where replies go
    to: email,
    subject: "Your ERAM Verification Code",
    text: `Your verification code is ${code}\n\nThis code expires in 10 minutes.`, // Plain text fallback
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Your ERAM Verification Code</title>
      </head>
      <body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:20px">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.1)">
                <!-- Header -->
                <tr>
                  <td style="background:linear-gradient(135deg,#5A31F4,#752ACA);padding:40px 30px;text-align:center">
                    <h1 style="color:white;font-size:28px;margin:0">ERAM</h1>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding:40px 30px;text-align:center">
                    <h2 style="color:#1a1a1a;margin-bottom:20px">Your Verification Code</h2>
                    <div style="font-size:48px;font-weight:bold;letter-spacing:12px;color:#5A31F4;background:#f0eafc;padding:20px 40px;border-radius:12px;display:inline-block;margin:20px auto">
                      ${code}
                    </div>
                    <p style="color:#555;font-size:16px;line-height:1.6;margin:30px 0">
                      Enter this code in the app to verify your email address.<br>
                      It expires in <strong>10 minutes</strong>.
                    </p>
                    <p style="color:#888;font-size:14px">
                      If you didn't request this code, please ignore this email.
                    </p>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="background:#f9f9f9;padding:30px;text-align:center;color:#888;font-size:13px">
                    <p style="margin:10px 0">
                      © 2025 ERAM • Helping parents raise confident kids
                    </p>
                    <p style="margin:10px 0">
                      Questions? Email <a href="mailto:eram.tech.khi@gmail.com" style="color:#5A31F4">support@eram.app</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    // These headers dramatically reduce spam score
    headers: {
      "X-Entity-ID": "eram-verification",
      "List-Unsubscribe": "<mailto:unsubscribe@eram.app>",
      "Precedence": "bulk",
    },
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Verification email sent successfully");
  } catch (error) {
    console.error("Failed to send email:", error);
    error.message = `Verification email failed: ${error.message}`;
    throw error;
  }
};

const consentMail = async (email) => {
  assertMailConfig();
  const transporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,        // e.g. eram.tech.khi@gmail.com
      pass: process.env.EMAIL_PASS,        // App Password (not regular password!)
    },
  });

  const mailOptions = {
    from: '"ERAM" <no-reply@eram.app>',           // This is what shows
    sender: process.env.EMAIL_USER,               // Actual sending address
    replyTo: "support@eram.app",                  // Where replies go
    to: email,
    subject: "ERAM Consent Form",
    text: "Please find attached the ERAM consent form.",
    html: `
     <!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ERAM Doctor Verification Consent</title>
</head>

<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:20px">
<tr>
<td align="center">

<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.1)">

<!-- Header -->
<tr>
<td style="background:linear-gradient(135deg,#5A31F4,#752ACA);padding:40px 30px;text-align:center">
<h1 style="color:white;font-size:28px;margin:0">ERAM</h1>
<p style="color:#e0d7ff;margin-top:8px">Doctor Verification</p>
</td>
</tr>

<!-- Body -->
<tr>
<td style="padding:40px 30px;text-align:left">

<h2 style="color:#1a1a1a;margin-bottom:16px;text-align:center">
Consent for PMDC Verification
</h2>

<p style="color:#555;font-size:16px;line-height:1.7">
To protect parents and children on ERAM, all medical professionals must be verified using the
<strong>Pakistan Medical & Dental Council (PMDC)</strong> public registry.
</p>

<p style="color:#555;font-size:16px;line-height:1.7">
By clicking <strong>Allow Verification</strong>, you authorize ERAM to use your submitted details
(name, PMDC number, and related information) to check your medical registration from the
PMDC public database solely for verification purposes.
</p>

<p style="color:#555;font-size:16px;line-height:1.7">
If your PMDC record cannot be verified, your doctor account will not be activated.
</p>

<!-- CTA Button -->
<div style="text-align:center;margin:35px 0">
<a href="https://api.eram.app/doctor/consent?token={{CONSENT_TOKEN}}"
   style="background:#5A31F4;color:white;text-decoration:none;
          padding:16px 32px;border-radius:10px;
          font-size:16px;font-weight:600;display:inline-block">
Allow PMDC Verification
</a>
</div>

<p style="color:#999;font-size:14px;text-align:center">
If you did not request doctor verification on ERAM, please ignore this email.
</p>

</td>
</tr>

<!-- Footer -->
<tr>
<td style="background:#f9f9f9;padding:30px;text-align:center;color:#888;font-size:13px">
<p style="margin:10px 0">
© 2025 ERAM • Helping parents raise confident kids
</p>
<p style="margin:10px 0">
Questions? <a href="mailto:support@eram.app" style="color:#5A31F4">support@eram.app</a>
</p>
</td>
</tr>

</table>
</td>
</tr>
</table>
</body>
</html>
`,

    headers: {
      "X-Entity-ID": "eram-consent",
      "List-Unsubscribe": "<mailto:support@eram.app>",
      "Precedence": "bulk",
    },
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Consent email sent successfully");
  } catch (error) {
    console.error("Failed to send consent email:", error);
    error.message = `Consent email failed: ${error.message}`;
    throw error;
  }
};

module.exports = { sendMail, consentMail };