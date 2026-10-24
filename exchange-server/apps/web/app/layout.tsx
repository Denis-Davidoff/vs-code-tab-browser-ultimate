import "../../../../media/liquid-loader.css";
import "./chat-theme.css";
import "./style.css";
import "../../../../media/appearance.css";
export const metadata = {
  title: "AI Browser — Remote workspace",
  description:
    "Your VS Code workspace, within reach. Connect to your AI Browser chat from anywhere.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
