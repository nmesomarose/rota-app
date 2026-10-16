import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Schedule: undefined;
  Feed: undefined;
  Team: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
};
