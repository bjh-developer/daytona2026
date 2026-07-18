import { Link } from 'react-router-dom'
import '../src/index.css'

function MemeScamPage() {
  const memes = [
    {
      id: 1,
      src: '/meme1.jpeg',
      alt: 'Tralala',
      position: 'top-left',
    },
    {
      id: 2,
      src: '/meme2.jpeg',
      alt: 'Sad Monkey',
      position: 'top-center',
    },
    {
      id: 3,
      src: '/meme3.jpeg',
      alt: 'Squidward',
      position: 'top-right',
    },
    {
      id: 4,
      src: '/meme4.jpeg',
      alt: 'Boy 3',
      position: 'left-top',
    },
    {
      id: 5,
      src: '/meme5.jpeg',
      alt: 'Boy 2',
      position: 'right-top',
    },
    {
      id: 6,
      src: '/meme6.jpeg',
      alt: 'Boy 1',
      position: 'left-bottom',
    },
    {
      id: 7,
      src: '/meme7.jpeg',
      alt: 'Anything',
      position: 'right-bottom',
    },
  ]

  return (
    <section className="meme-scam-page">
      <div className="meme-container">
        {memes.map((meme) => (
          <div
            key={meme.id}
            className={`meme-position ${meme.position}`}
          >
            <img
              src={meme.src}
              alt={meme.alt}
              className="meme-image"
              onError={(e) => {
                // Fallback styling if image fails
                e.currentTarget.style.background = '#333'
              }}
            />
          </div>
        ))}

        <div className="scammed-overlay">
          <div className="scammed-note">
            you got
            <br />
            scammed!
          </div>
        </div>
      </div>

      <div className="meme-footer">
        <Link to="/">Back to fake government page</Link>
      </div>
    </section>
  )
}

export default MemeScamPage
