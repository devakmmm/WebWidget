// test-yahoo-smtp.js
// Usage: node test-yahoo-smtp.js

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.mail.yahoo.com',
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: 'biffdiaz@yahoo.com', // your Yahoo email
    pass: 'kmhrzztqkovfauts' // your Yahoo app password
  }
});

async function main() {
  try {
    let info = await transporter.sendMail({
      from: 'biffdiaz@yahoo.com',
      to: 'biffdiaz@yahoo.com', // send to yourself for test
      subject: 'Yahoo SMTP Test',
      text: 'This is a test email sent from Node.js using Yahoo SMTP.'
    });
    console.log('Test email sent:', info.messageId);
  } catch (err) {
    console.error('Error sending test email:', err);
  }
}

main();

// node test-yahoo-smtp.js
