import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Schedule: undefined;
  Feed: undefined;
  Team: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Auth: { initialMode?: 'login' | 'signup'; pendingInviteToken?: string; prefilledEmail?: string } | undefined;
  ForgotPassword: { prefilledEmail?: string } | undefined;
  ResetPassword: { token?: string; email?: string } | undefined;
  BusinessSelect: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Billing: undefined;
  AcceptInvitation: { token?: string };
};
