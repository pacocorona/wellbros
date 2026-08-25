"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// El `useTheme` que traía la plantilla de shadcn era el de next-themes, que
// este proyecto no usa: sin su proveedor el hook devuelve un contexto vacío y
// el tema quedaba clavado en "system", de modo que quien eligiera "claro" con
// el sistema en oscuro veía el aviso oscuro sobre la pantalla clara. El tema
// aquí lo lleva @/components/theme-provider.
import { useTheme } from "@/components/theme-provider"

const Toaster = ({ ...props }: ToasterProps) => {
  // `resolvedTheme` y no `theme`: sonner necesita saber qué se está pintando,
  // y "system" lo resolvería por su cuenta con `prefers-color-scheme`, que es
  // justo lo que deja de valer cuando la persona eligió un tema explícito.
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
