import { Link } from 'react-router-dom'
import '../src/index.css'

function GovernmentPage() {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const nric = formData.get('nric')
    const phone = formData.get('phone')
    
    if (nric && phone) {
      window.location.href = `/verify?nric=${encodeURIComponent(nric as string)}&phone=${encodeURIComponent(phone as string)}`
    }
  }

  return (
    <section className="gov-page">
      <div className="demo">⚠️ DEMO ONLY — controlled phishing replica for detonate.sg. Not a real government site.</div>
      
      {/* Header */}
      <header className="gov-header">
        <div className="gov-header-content">
          <div className="gov-logo-section">
            <div className="gov-title">
              A Singapore Government Agency Website
            </div>
          </div>
          <div className="gov-ministry">
            Ministry of Social and Family Development (MSF) ⚙️
          </div>
        </div>
      </header>

      {/* Breadcrumb */}
      <div className="gov-breadcrumb">Government payouts · GST Voucher Scheme 2026</div>

      {/* Main Content */}
      <div className="gov-main">
        <div className="gov-card">
          <h1>GST Voucher Claim</h1>
          <p className="muted">
            You are eligible for up to <b>$850</b> in cash. Verify your identity to receive your payout by 7 August 2026.
          </p>

          <form onSubmit={handleSubmit}>
            <div className="sgds-form-group">
              <label htmlFor="nric" className="sgds-form-label">NRIC / FIN</label>
              <input 
                id="nric" 
                name="nric" 
                className="sgds-input"
                placeholder="e.g. S1234567A" 
                autoComplete="off"
                required
              />
            </div>
            
            <div className="sgds-form-group">
              <label htmlFor="phone" className="sgds-form-label">Mobile number</label>
              <div className="pref">
                <span className="sgds-prefix">+65</span>
                <input 
                  id="phone" 
                  name="phone" 
                  type="tel" 
                  className="sgds-input"
                  placeholder="9123 4567" 
                  autoComplete="off"
                  required
                />
              </div>
            </div>
            
            <div className="tgnote">
              <span className="tgnote-icon">🔒</span>
              <span>For security, the final step verifies your identity through <a href="#" className="sgds-link">Telegram</a>.</span>
            </div>
            
            
          </form>

          <p style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <Link to="/verify" className="sgds-button is-primary">Verify & Claim Voucher</Link>
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="gov-footer">
        <div className="gov-footer-content">
          <div className="gov-footer-logos">
            <span className="footer-logo">🏢</span>
            <span className="footer-logo">🇸🇬</span>
          </div>
          <div className="gov-footer-links">
            <a href="#privacy">Privacy</a>
            <span className="separator">·</span>
            <a href="#terms">Terms of Use</a>
            <span className="separator">·</span>
            <a href="#contact">Contact Us</a>
          </div>
          <div className="gov-footer-copyright">
            © 2026 Government of Singapore
          </div>
        </div>
      </footer>
    </section>
  )
}

export default GovernmentPage
