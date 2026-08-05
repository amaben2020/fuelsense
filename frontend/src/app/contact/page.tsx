'use client';

import { useState } from 'react';
import { gsap } from 'gsap';
import { MarketingFooter, MarketingNav } from '@/components/marketing/MarketingChrome';
import { useGsapScope } from '@/components/marketing/useScrollReveal';
import { api } from '@/lib/api';
import '../marketing.css';

const TOPICS = [
  { value: 'trackers', label: 'Buy Teltonika trackers' },
  { value: 'setup', label: 'Set up my fleet' },
  { value: 'demo', label: 'See a demo' },
  { value: 'other', label: 'Something else' },
];

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export default function ContactPage() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const scope = useGsapScope(() => {
    gsap.from('[data-contact-line] > span', {
      yPercent: 115,
      duration: 1,
      ease: 'expo.out',
      stagger: 0.08,
    });
    gsap.from('[data-contact-reveal]', {
      opacity: 0,
      y: 24,
      duration: 0.8,
      ease: 'power3.out',
      delay: 0.3,
      stagger: 0.08,
    });
  });

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    setStatus({ kind: 'sending' });
    try {
      await api('/contact', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({
          name: data.get('name'),
          email: data.get('email'),
          company: data.get('company'),
          phone: data.get('phone'),
          fleet_size: data.get('fleet_size'),
          topic: data.get('topic'),
          message: data.get('message'),
        }),
      });
      form.reset();
      setStatus({ kind: 'sent' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Could not send your message. Please try again.',
      });
    }
  };

  return (
    <div className="fs-landing" ref={scope}>
      <MarketingNav />

      <section className="fs-shell fs-hero">
        <div className="fs-contact">
          <div>
            <span className="fs-eyebrow" data-contact-reveal>
              Contact
            </span>

            <h1 className="fs-display" style={{ marginTop: '1.5rem', fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
              <span className="fs-reveal" data-contact-line>
                <span>Let&rsquo;s get your</span>
              </span>
              <span className="fs-reveal" data-contact-line>
                <span>
                  fleet <em>measured</em>.
                </span>
              </span>
            </h1>

            <p className="fs-lede" style={{ marginTop: '1.5rem' }} data-contact-reveal>
              Tell us what you run and what you need. We supply and configure Teltonika hardware,
              set up your account, and get the first vehicle reporting.
            </p>

            <div className="fs-contactfacts" data-contact-reveal>
              {[
                ['Hardware', 'Teltonika FMC150, configured for your vehicles before it ships'],
                ['Setup', 'Account, vehicles, drivers and fuel price configured with you'],
                ['Support', 'We stay on until the numbers match your receipts'],
              ].map(([title, body]) => (
                <div className="fs-feat" key={title}>
                  <h3 className="fs-feat__name" style={{ fontSize: '1.0625rem' }}>
                    {title}
                  </h3>
                  <p className="fs-small">{body}</p>
                </div>
              ))}
            </div>
          </div>

          <form className="fs-form" onSubmit={submit} data-contact-reveal>
            <div className="fs-form__grid">
              <label className="fs-field">
                <span className="fs-field__label">Your name *</span>
                <input className="fs-input" name="name" required maxLength={120} />
              </label>

              <label className="fs-field">
                <span className="fs-field__label">Email *</span>
                <input className="fs-input" name="email" type="email" required />
              </label>

              <label className="fs-field">
                <span className="fs-field__label">Company</span>
                <input className="fs-input" name="company" maxLength={120} />
              </label>

              <label className="fs-field">
                <span className="fs-field__label">Phone</span>
                <input className="fs-input" name="phone" type="tel" maxLength={40} />
              </label>

              <label className="fs-field">
                <span className="fs-field__label">Fleet size</span>
                <input className="fs-input" name="fleet_size" placeholder="e.g. 6 vehicles" />
              </label>

              <label className="fs-field">
                <span className="fs-field__label">What do you need?</span>
                <select className="fs-select" name="topic" defaultValue="trackers">
                  {TOPICS.map((topic) => (
                    <option key={topic.value} value={topic.value}>
                      {topic.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="fs-field" style={{ marginTop: '1rem' }}>
              <span className="fs-field__label">Message *</span>
              <textarea
                className="fs-textarea"
                name="message"
                required
                maxLength={4000}
                placeholder="What do you run, and what are you trying to find out?"
              />
            </label>

            {status.kind === 'sent' && (
              <p className="fs-note fs-note--ok" style={{ marginTop: '1rem' }} role="status">
                Thank you — your message is on its way. We reply to every enquiry.
              </p>
            )}
            {status.kind === 'error' && (
              <p className="fs-note fs-note--bad" style={{ marginTop: '1rem' }} role="alert">
                {status.message}
              </p>
            )}

            <button
              type="submit"
              className="fs-btn fs-btn--primary"
              style={{ marginTop: '1.25rem', width: '100%', justifyContent: 'center' }}
              disabled={status.kind === 'sending'}
            >
              {status.kind === 'sending' ? 'Sending…' : 'Send enquiry'}
            </button>

            <p className="fs-small" style={{ marginTop: '0.875rem', textAlign: 'center' }}>
              Or email us directly at{' '}
              <a href="mailto:uzochukwubenamara@gmail.com" className="fs-em">
                uzochukwubenamara@gmail.com
              </a>
            </p>
          </form>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
