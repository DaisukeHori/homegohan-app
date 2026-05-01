import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

test('renders text', () => {
  const { getByText } = render(<Text>hello</Text>);
  expect(getByText('hello')).toBeTruthy();
});
