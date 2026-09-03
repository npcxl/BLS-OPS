import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

/**
 * 命令中心图标：双提示符加回车光标，hover 时光标敲击两次。
 */
const CommandCenterIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "" },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      animate(
        ".cc-caret",
        { opacity: [1, 0, 1, 0, 1] },
        { duration: 0.8, ease: "easeInOut" },
      );
      animate(
        ".cc-chevrons",
        { x: [0, 2, 0] },
        { duration: 0.4, ease: "easeInOut" },
      );
    }, [animate]);

    const stop = useCallback(() => {
      animate(".cc-caret", { opacity: 1 }, { duration: 0.2, ease: "easeOut" });
      animate(".cc-chevrons", { x: 0 }, { duration: 0.2, ease: "easeOut" });
    }, [animate]);

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
    }));

    return (
      <motion.svg
        ref={scope}
        onHoverStart={start}
        onHoverEnd={stop}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`cursor-pointer ${className}`}
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <motion.path
          className="cc-chevrons"
          d="M6 7l4 5l-4 5"
        />
        <motion.path className="cc-chevrons" d="M12 7l4 5l-4 5" />
        <motion.path className="cc-caret" d="M18 17l2 0" />
      </motion.svg>
    );
  },
);

CommandCenterIcon.displayName = "CommandCenterIcon";
export default CommandCenterIcon;
