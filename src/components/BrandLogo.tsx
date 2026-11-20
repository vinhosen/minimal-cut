import React from 'react';

interface BrandLogoProps {
  size?: number;
  className?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ size = 28, className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 512 512"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    <rect width="512" height="512" rx="116" fill="#18181b" />
    <rect x="4" y="4" width="504" height="504" rx="112" stroke="#ffffff" strokeOpacity="0.1" strokeWidth="8" />
    <path
      d="M112 152C112 134.327 126.327 120 144 120H228V392H144C126.327 392 112 377.673 112 360V152Z"
      fill="#ffffff"
    />
    <rect x="134" y="152" width="26" height="22" rx="6" fill="#18181b" fillOpacity="0.22" />
    <rect x="134" y="245" width="26" height="22" rx="6" fill="#18181b" fillOpacity="0.22" />
    <rect x="134" y="338" width="26" height="22" rx="6" fill="#18181b" fillOpacity="0.22" />
    <path
      d="M284 120H368C385.673 120 400 134.327 400 152V360C400 377.673 385.673 392 368 392H284V120ZM320 206V306L372 256L320 206Z"
      fill="#ffffff"
      fillRule="evenodd"
      clipRule="evenodd"
    />
    <rect x="244" y="88" width="24" height="344" rx="12" fill="#0ea5e9" />
    <path d="M226 76H286L272 106H240L226 76Z" fill="#38bdf8" />
  </svg>
);
