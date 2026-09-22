"""Outbound transactional email — password reset links today, nothing else yet. Plain SMTP
(stdlib smtplib) rather than boto3/the SES API: the credentials this points at are SES's *SMTP*
credentials (an access-key-derived username/password pair for port 587), which only work for
SMTP, not for signing raw API calls.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "no-reply@annobio.org")
SMTP_USE_TLS = os.environ.get("SMTP_USE_TLS", "true").strip().lower() not in ("0", "false", "")


def send_email(to: str, subject: str, body: str) -> None:
    """Sends a plain-text email. If SMTP isn't configured (no .env entry — e.g. local dev),
    logs what would have been sent instead of raising, so the forgot-password flow is still
    exercisable (the reset link just shows up in the console log rather than an inbox)."""
    if not (SMTP_HOST and SMTP_USER and SMTP_PASSWORD):
        print(f"[mailer] SMTP not configured — would have sent to {to}:\nSubject: {subject}\n\n{body}")
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
        if SMTP_USE_TLS:
            server.starttls(context=ssl.create_default_context())
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)
