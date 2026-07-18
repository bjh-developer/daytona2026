import { Routes, Route, Navigate } from 'react-router-dom'
import GovernmentPage from './GovernmentPage'
import TelegramPage from './TelegramPage'
import MemeScamPage from './MemeScamPage'
import './App.css'

function App() {
  return (
    <main style={{ padding: '2rem' }}>
      

      <Routes>
        <Route path="/" element={<GovernmentPage />} />
        <Route path="/verify" element={<TelegramPage />} />
        <Route path="/meme" element={<MemeScamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  )
}

export default App
