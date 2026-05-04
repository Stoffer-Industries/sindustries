import React from 'react';
import { FlatList, Text, View } from 'react-native';

export function AlertsScreen() {
  const demo = [
    { id: 'a1', title: '80% warning', body: 'Card ending 1234 is at 80%.' },
    { id: 'a2', title: '95% warning', body: 'Card ending 1234 is at 95%.' }
  ];

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, gap: 12 }}>
      <Text style={{ color: '#6b7280' }}>
        Demo list; will be backed by server-generated events.
      </Text>
      <FlatList
        data={demo}
        keyExtractor={(a) => a.id}
        style={{ flex: 1 }}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        renderItem={({ item }) => (
          <View
            style={{
              borderWidth: 1,
              borderColor: '#e5e7eb',
              borderRadius: 12,
              padding: 12,
              gap: 6
            }}
          >
            <Text style={{ fontWeight: '700' }}>{item.title}</Text>
            <Text>{item.body}</Text>
          </View>
        )}
      />
    </View>
  );
}

