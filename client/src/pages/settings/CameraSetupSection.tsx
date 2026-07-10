import { Section } from './parts'

export function CameraSetupSection() {
  return (
    <Section
      title="Camera setup"
      subtitle="Tools for aiming and adjusting the physical camera."
    >
      <div className="px-4 py-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <h3 className="font-semibold text-[var(--color-text-primary)]">
            Focus Assistant
          </h3>
          <p className="mt-1 text-sm leading-5 text-[var(--color-text-secondary)]">
            Magnify a target and watch its sharpness while you turn the lens.
          </p>
        </div>
        <a
          href="/settings/focus-assistant"
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--color-ink)] px-5 py-2.5 font-semibold text-[var(--color-on-ink)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 sm:mt-0 sm:w-auto sm:flex-none"
        >
          Open assistant
        </a>
      </div>
    </Section>
  )
}
