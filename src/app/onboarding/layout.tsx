export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {children}
    </div>
  )
}

