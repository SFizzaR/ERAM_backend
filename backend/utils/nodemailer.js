const nodemailer = require("nodemailer");

const sendMail = (email, emailToken) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  const backendBaseURL = "http://localhost:3000"; // change to production URL later
  const logoURL = `${backendBaseURL}/public/logo.png`;
  const emailIconURL = `${backendBaseURL}/public/email.png`;

  const mailOptions = {
    from: 'Team ERAM',
    to: email,
    subject: 'ERAM - Email Verification',
    html: `
    <div style="width:97%; text-align:center; font-family: Arial, sans-serif; padding:20px; background-color:#f9f9f9;">
      <img src="${logoURL}" alt="Logo" style="width:70px; margin-bottom:15px;">
      <div style="max-width:500px; margin:0 auto 20px auto; background-color:#CDC4D5; padding:20px; border-radius:8px;">
        <img src="${emailIconURL}" alt="Email Illustration" style="width:90px; max-width:100%; height:auto;">
      </div>
      <p style="font-size:16px; color:#333; margin:10px 0;">Hi there!</p>
      <p style="font-size:14px; color:#555; margin:10px 0;">Verify your email address by clicking on the button below:</p>
      <p style="margin:20px 0;">
        <a href="eram://verify-email?token=${emailToken}">
           style="display:inline-block; padding:12px 24px; background-color:#007bff; color:#ffffff; text-decoration:none; border-radius:5px; font-size:14px; font-weight:bold;">
          Click here to verify
        </a>
      </p>
      <p style="font-size:12px; color:#777; margin-top:20px; line-height:1.5;">
        If you didn't ask to verify this address, you can safely ignore this email.
      </p>
      <p style="font-size:14px; color:#333; margin-top:20px;">Thanks for signing up!</p>
      <p style="font-size:14px; color:#333; margin-top:5px;">~ Team ERAM</p>
    </div>
  `
  };


  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log(error);
    } else {
      console.log('Email sent: ' + info.response);
    }
  });
}

module.exports = sendMail;