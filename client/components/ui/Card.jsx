export default function Card({ children, className = "", padding = true, as: Component = "div", ...rest }) {
  return (
    <Component
      className={`bg-card rounded-2xl shadow-soft transition-all duration-300 ${padding ? "p-4 sm:p-5" : ""} ${className}`}
      {...rest}
    >
      {children}
    </Component>
  );
}
