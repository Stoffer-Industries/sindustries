import { HandleSSOCallback } from '@clerk/react';
import { useNavigate } from 'react-router-dom';
import { consumeClerkSsoDestination } from '../lib/clerkSsoDestination.js';

export default function ClerkSsoCallback() {
  const navigate = useNavigate();

  return (
    <HandleSSOCallback
      navigateToApp={({ decorateUrl }) => {
        const destination = decorateUrl(consumeClerkSsoDestination());
        if (/^https?:\/\//i.test(destination)) {
          window.location.assign(destination);
          return;
        }
        navigate(destination, { replace: true });
      }}
      navigateToSignIn={() => navigate('/login', { replace: true })}
      navigateToSignUp={() => navigate('/signup', { replace: true })}
    />
  );
}
