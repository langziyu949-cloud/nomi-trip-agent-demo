import type { SVGProps } from "react";

function IconBase({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function RouteIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h3a4 4 0 0 0 4-4v-2a4 4 0 0 1 3-4"/></IconBase>;
}

export function SparkIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="m12 3-1.4 4.2a5 5 0 0 1-3.2 3.2L3 12l4.4 1.6a5 5 0 0 1 3.2 3.2L12 21l1.5-4.2a5 5 0 0 1 3.1-3.2L21 12l-4.4-1.6a5 5 0 0 1-3.1-3.2L12 3Z"/></IconBase>;
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05-2.86 2.86-.05-.05A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.08A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.05.05-2.86-2.86.05-.05A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H1.8V9.55h.08A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.05-.05 2.86-2.86.05.05A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V1.8h4.05v.08A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.05-.05 2.86 2.86-.05.05A1.7 1.7 0 0 0 19.4 8c.14.4.36.75.68 1 .3.27.7.4 1.1.4h.08v4.05h-.08A1.7 1.7 0 0 0 19.4 15Z"/></IconBase>;
}

export function ArrowIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M5 12h14M13 6l6 6-6 6"/></IconBase>;
}

export function WeatherIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M17.5 18H7a4 4 0 1 1 1.1-7.85A5.5 5.5 0 0 1 18.7 12 3 3 0 0 1 17.5 18Z"/><path d="M8.5 6.5 7 5M13 5V3M4.5 10H2"/></IconBase>;
}

export function BatteryIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4M6 10v4M9 10v4M12 10v4"/></IconBase>;
}

export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></IconBase>;
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18"/></IconBase>;
}

export function EditIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></IconBase>;
}
