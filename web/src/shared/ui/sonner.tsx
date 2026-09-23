import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { isDark } = useTheme();

  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      position="top-right"
      // Sonner makes the toaster full-width below 600px. On a phone that puts
      // it over the shell's top bar, which is its own kind of collision, so
      // below md it sits just under the bar instead. 45px is the phone bar's
      // min-height (AppShell.tsx); this stays a plain value rather than a
      // class because sonner writes the offset as an inline CSS var.
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 52px)", left: 16, right: 16 }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
